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

    /** Excluded from the CMS pending total by AlertRepository::getTotalAlerts(). */
    private const TEST_USER = 'prova';

    protected SplObjectStorage $clients;

    private int $lastCount = -1;

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
        // lastCount must NOT be updated here: it is the broadcast baseline shared by
        // every widget, and overwriting it would suppress the next broadcast for the
        // widgets that are already connected.
        try {
            $this->sendAlertCount($conn, $this->getPendingAlertCount(), false);
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
                // As in onOpen, the shared broadcast baseline is left untouched.
                try {
                    $this->sendAlertCount($from, $this->getPendingAlertCount(), false);
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
            $count = $this->getPendingAlertCount();
        } catch (Throwable $e) {
            // An exception escaping a ReactPHP timer can terminate the process and
            // disconnect every widget. Log it and allow the next cycle to retry.
            $this->logger->error('[WebSocketServer::broadcastAlerts] Error consultando alertas.', [
                'error_message' => $e->getMessage(),
            ]);
            return;
        }

        // Solo emitimos si el estado ha cambiado
        if ($count === $this->lastCount) {
            return;
        }

        $previousCount = $this->lastCount;
        $this->lastCount = $count;

        if ($this->clients->count() === 0) {
            return;
        }

        // Notify only when new pending incidents were added. A decrease must update
        // the displayed count but must not trigger sound/blinking again.
        $notify = $previousCount >= 0 && $count > $previousCount;
        $this->broadcastJson([
            'alerts' => $count,
            'notify' => $notify,
        ]);

        $this->logger->info('[WebSocketServer::broadcastAlerts] Mensaje emitido.', [
            'pending_count' => $count,
            'previous_count' => $previousCount,
            'notify'        => $notify,
            'total_clients' => $this->clients->count(),
        ]);
    }

    private function getPendingAlertCount(): int
    {
        $this->em->clear();

        // Mirror AlertRepository::getTotalAlerts(), which produces the total shown
        // in the CMS "Alertes pendents" screen: pending state, excluding the test
        // user. The previous updatedAt/fromCms exclusions made the widget disagree
        // with the CMS whenever an alert was edited or created from the CMS.
        return (int) $this->alertRepository->createQueryBuilder('a')
            ->select('COUNT(a.id)')
            ->where('a.state = :state')
            ->andWhere('a.user != :testUser')
            ->setParameter('state', 1)
            ->setParameter('testUser', self::TEST_USER)
            ->getQuery()
            ->getSingleScalarResult();
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