<?php

namespace App;

use App\Repository\AlertRepository;
use Doctrine\ORM\EntityManagerInterface;
use Psr\Log\LoggerInterface;
use Ratchet\ConnectionInterface;
use Ratchet\MessageComponentInterface;
use React\EventLoop\Loop;
use SplObjectStorage;
use Throwable;

class WebSocketServer implements MessageComponentInterface
{
    private const POLL_INTERVAL_SECONDS = 2;

    /** Excluded from the widget total, as in AlertRepository::getTotalAlerts(). */
    private const TEST_USER = 'prova';

    protected SplObjectStorage $clients;

    private int $lastCount = -1;

    /**
     * Highest pending alert id ever observed, used as the arrival signal.
     *
     * The count alone cannot detect a new incident: under the widget business
     * rule an alert leaves the pending set as soon as an operator handles it
     * (updatedAt), so an arrival and a removal inside the same poll window
     * cancel out and the count looks unchanged. This watermark only ever moves
     * forward, so a new alert is still detected when that happens.
     */
    private int $lastSeenAlertId = -1;

    public function __construct(
        private readonly AlertRepository $alertRepository,
        private readonly EntityManagerInterface $em,
        private readonly LoggerInterface $logger,
    ) {
        $this->clients = new SplObjectStorage();

        $this->logger->info('[WebSocketServer] Servidor iniciado.', [
            'poll_interval_seconds' => self::POLL_INTERVAL_SECONDS,
        ]);

        Loop::get()->addPeriodicTimer(self::POLL_INTERVAL_SECONDS, function () {
            $this->broadcastAlerts();
        });
    }

    public function onOpen(ConnectionInterface $conn): void
    {
        $this->clients->attach($conn);

        $this->logger->info('[WebSocketServer::onOpen] Nueva conexión.', [
            'resource_id'   => $conn->resourceId,
            'total_clients' => $this->clients->count(),
        ]);

        // Always query the authoritative value on connect. The old implementation
        // sent nothing before the first timer and could send a value up to 14s old.
        // The broadcast baselines must NOT be updated here: they are shared by every
        // widget, and overwriting them would suppress the next broadcast for the
        // widgets that are already connected.
        try {
            $snapshot = $this->getPendingAlertSnapshot();
            $this->sendAlertCount($conn, $snapshot['count'], false);
        } catch (Throwable $e) {
            $this->logger->error('[WebSocketServer::onOpen] No se pudo obtener el contador inicial.', [
                'resource_id'   => $conn->resourceId,
                'error_message' => $e->getMessage(),
            ]);
        }

        echo "Conexión abierta: ({$conn->resourceId})\n";
    }

    public function onMessage(ConnectionInterface $from, $msg): void
    {
        $data = json_decode($msg, true);

        if (!is_array($data) || !isset($data['type'])) {
            $this->logger->warning('[WebSocketServer::onMessage] Mensaje inválido ignorado.', [
                'resource_id' => $from->resourceId,
                'raw_message' => $msg,
            ]);
            return;
        }

        switch ($data['type']) {
            case 'stop_alerts':
                // This is the only application event intended for all widgets.
                $this->broadcastJson(['type' => 'stop_alerts']);
                break;

            case 'sync':
                // A sync request is private to the requesting widget. Broadcasting
                // it previously made legacy widgets treat it as a new notification.
                // As in onOpen, the shared broadcast baselines are left untouched.
                try {
                    $snapshot = $this->getPendingAlertSnapshot();
                    $this->sendAlertCount($from, $snapshot['count'], false);
                } catch (Throwable $e) {
                    $this->logger->error('[WebSocketServer::onMessage] Error sincronizando contador.', [
                        'resource_id'   => $from->resourceId,
                        'error_message' => $e->getMessage(),
                    ]);
                }
                break;

            case 'ping':
                // Optional application-level compatibility. Ratchet's protocol-level
                // keepalive remains the primary heartbeat.
                $this->sendJson($from, ['type' => 'pong']);
                break;

            case 'pong':
                break;

            default:
                $this->logger->warning('[WebSocketServer::onMessage] Tipo de mensaje ignorado.', [
                    'resource_id' => $from->resourceId,
                    'type'        => $data['type'],
                ]);
                return;
        }

        $this->logger->info('[WebSocketServer::onMessage] Mensaje procesado.', [
            'resource_id' => $from->resourceId,
            'type'        => $data['type'],
        ]);
    }

    public function onClose(ConnectionInterface $conn): void
    {
        $this->clients->detach($conn);

        $this->logger->info('[WebSocketServer::onClose] Conexión cerrada.', [
            'resource_id'      => $conn->resourceId,
            'remaining_clients' => $this->clients->count(),
        ]);

        echo "Conexión cerrada: ({$conn->resourceId})\n";
    }

    public function onError(ConnectionInterface $conn, \Exception $e): void
    {
        $this->logger->error('[WebSocketServer::onError] Error.', [
            'resource_id'   => $conn->resourceId,
            'error_message' => $e->getMessage(),
        ]);

        echo "Error: {$e->getMessage()}\n";
        $conn->close();
    }

    private function broadcastAlerts(): void
    {
        try {
            $snapshot = $this->getPendingAlertSnapshot();
        } catch (Throwable $e) {
            // An exception escaping a ReactPHP timer can terminate the process and
            // disconnect every widget. Log it and allow the next cycle to retry.
            $this->logger->error('[WebSocketServer::broadcastAlerts] Error consultando alertas.', [
                'error_message' => $e->getMessage(),
            ]);
            return;
        }

        $count = $snapshot['count'];
        $maxId = $snapshot['maxId'];

        $isFirstCycle = $this->lastCount < 0;
        // A restart must publish the current state without replaying an alarm for
        // incidents that were already pending.
        $hasNewAlert = !$isFirstCycle && $maxId > $this->lastSeenAlertId;
        $countChanged = $count !== $this->lastCount;

        $previousCount = $this->lastCount;
        $this->lastCount = $count;
        if ($maxId > $this->lastSeenAlertId) {
            $this->lastSeenAlertId = $maxId;
        }

        // Emit when the number changed or when a new incident arrived. The second
        // condition is what keeps an arrival visible when a simultaneous removal
        // leaves the count identical.
        if (!$countChanged && !$hasNewAlert) {
            return;
        }

        if ($this->clients->count() === 0) {
            return;
        }

        // Notify only for genuinely new incidents. Handling an alert lowers the
        // count but must not replay sound/blinking.
        $this->broadcastJson([
            'alerts' => $count,
            'notify' => $hasNewAlert,
        ]);

        $this->logger->info('[WebSocketServer::broadcastAlerts] Mensaje emitido.', [
            'pending_count'  => $count,
            'previous_count' => $previousCount,
            'max_alert_id'   => $maxId,
            'notify'         => $hasNewAlert,
            'masked_arrival' => $hasNewAlert && !$countChanged,
            'total_clients'  => $this->clients->count(),
        ]);
    }

    /**
     * Pending incidents for the widget, with the highest id in that set.
     *
     * This is intentionally NOT the CMS "Alertes pendents" total. The widget shows
     * only incidents still awaiting an operator:
     *   - pending state
     *   - not yet handled by an operator (updatedAt IS NULL)
     *   - not created manually from the CMS (fromCms IS NULL)
     *   - excluding the test user
     * The widget number can therefore legitimately be lower than the CMS total.
     *
     * @return array{count: int, maxId: int}
     */
    private function getPendingAlertSnapshot(): array
    {
        $this->em->clear();

        $row = $this->alertRepository->createQueryBuilder('a')
            ->select('COUNT(a.id) AS cnt', 'MAX(a.id) AS maxId')
            ->where('a.state = :state')
            ->andWhere('a.updatedAt IS NULL')
            ->andWhere('a.fromCms IS NULL')
            ->andWhere('a.user != :testUser')
            ->setParameter('state', 1)
            ->setParameter('testUser', self::TEST_USER)
            ->getQuery()
            ->getSingleResult();

        return [
            'count' => (int) ($row['cnt'] ?? 0),
            // MAX() is NULL when nothing is pending; 0 keeps the watermark usable.
            'maxId' => (int) ($row['maxId'] ?? 0),
        ];
    }

    private function sendAlertCount(ConnectionInterface $client, int $count, bool $notify): void
    {
        $this->sendJson($client, [
            'alerts' => $count,
            'notify' => $notify,
        ]);
    }

    private function sendJson(ConnectionInterface $client, array $payload): void
    {
        try {
            $client->send(json_encode($payload));
        } catch (Throwable $e) {
            $this->logger->warning('[WebSocketServer] Error enviando mensaje a un cliente.', [
                'resource_id'   => $client->resourceId,
                'error_message' => $e->getMessage(),
            ]);
            $client->close();
        }
    }

    private function broadcastJson(array $payload): void
    {
        foreach ($this->clients as $client) {
            $this->sendJson($client, $payload);
        }
    }
}
