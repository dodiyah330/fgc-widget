<?php

declare(strict_types=1);

namespace Doctrine\ORM {
    interface EntityManagerInterface
    {
        public function clear();
    }
}

namespace Psr\Log {
    interface LoggerInterface
    {
    }
}

namespace Ratchet {
    interface ConnectionInterface
    {
        public function send($data);

        public function close();
    }

    interface MessageComponentInterface
    {
    }
}

namespace React\EventLoop {
    final class Loop
    {
        public static $timerCallback;
        public static $timerInterval;

        public static function get(): self
        {
            return new self();
        }

        public function addPeriodicTimer($interval, callable $callback): void
        {
            self::$timerInterval = $interval;
            self::$timerCallback = $callback;
        }
    }
}

namespace App\Repository {
    final class FakeQuery
    {
        private AlertRepository $repository;

        public function __construct(AlertRepository $repository)
        {
            $this->repository = $repository;
        }

        public function getSingleScalarResult(): int
        {
            if ($this->repository->failQuery) {
                throw new \RuntimeException('database unavailable');
            }

            return $this->repository->count;
        }
    }

    final class FakeQueryBuilder
    {
        public array $whereClauses = [];
        private AlertRepository $repository;

        public function __construct(AlertRepository $repository)
        {
            $this->repository = $repository;
        }

        public function select($select): self
        {
            return $this;
        }

        public function where($where): self
        {
            $this->whereClauses[] = $where;

            return $this;
        }

        public function andWhere($where): self
        {
            $this->whereClauses[] = $where;

            return $this;
        }

        public function setParameter($name, $value): self
        {
            return $this;
        }

        public function getQuery(): FakeQuery
        {
            return new FakeQuery($this->repository);
        }
    }

    class AlertRepository
    {
        public int $count = 0;
        public bool $failQuery = false;
        public ?FakeQueryBuilder $lastQueryBuilder = null;

        public function createQueryBuilder($alias): FakeQueryBuilder
        {
            $this->lastQueryBuilder = new FakeQueryBuilder($this);

            return $this->lastQueryBuilder;
        }
    }
}

namespace Tests {
    use App\Repository\AlertRepository;
    use Doctrine\ORM\EntityManagerInterface;
    use Psr\Log\LoggerInterface;
    use Ratchet\ConnectionInterface;
    use React\EventLoop\Loop;

    final class FakeEntityManager implements EntityManagerInterface
    {
        public int $clearCalls = 0;

        public function clear(): void
        {
            ++$this->clearCalls;
        }
    }

    final class FakeLogger implements LoggerInterface
    {
        public array $entries = [];

        public function __call($name, $arguments): void
        {
            $this->entries[] = [$name, $arguments];
        }
    }

    final class FakeConnection implements ConnectionInterface
    {
        public int $resourceId;
        public array $messages = [];
        public bool $closed = false;

        public function __construct(int $resourceId)
        {
            $this->resourceId = $resourceId;
        }

        public function send($data): void
        {
            $this->messages[] = json_decode($data, true);
        }

        public function close(): void
        {
            $this->closed = true;
        }
    }

    function assertSame($expected, $actual, string $message): void
    {
        if ($expected !== $actual) {
            throw new \RuntimeException(sprintf(
                "%s\nExpected: %s\nActual: %s",
                $message,
                var_export($expected, true),
                var_export($actual, true)
            ));
        }
    }

    require dirname(__DIR__).'/server-patch/src/WebSocketServer.php';

    $repository = new AlertRepository();
    $repository->count = 5;
    $entityManager = new FakeEntityManager();
    $logger = new FakeLogger();
    $server = new \App\WebSocketServer($repository, $entityManager, $logger);
    assertSame(2, Loop::$timerInterval, 'Pending alerts must be polled every two seconds.');

    $first = new FakeConnection(1);
    $second = new FakeConnection(2);

    $server->onOpen($first);
    assertSame([['alerts' => 5, 'notify' => false]], $first->messages, 'Open must send current count.');
    assertSame(
        ['a.state = :state', 'a.user != :testUser'],
        $repository->lastQueryBuilder->whereClauses,
        'Count must mirror the CMS pending total (state + test-user exclusion).'
    );

    $server->onOpen($second);
    $first->messages = [];
    $second->messages = [];

    $server->onMessage($first, '{"type":"ping"}');
    assertSame([['type' => 'pong']], $first->messages, 'Ping response must be private.');
    assertSame([], $second->messages, 'Ping must not be broadcast.');

    $first->messages = [];
    $repository->count = 6;
    $server->onMessage($first, '{"type":"sync"}');
    assertSame([['alerts' => 6, 'notify' => false]], $first->messages, 'Sync must return authoritative count privately.');
    assertSame([], $second->messages, 'Sync must not be broadcast.');

    $first->messages = [];
    $server->onMessage($first, '{"type":"stop_alerts"}');
    assertSame([['type' => 'stop_alerts']], $first->messages, 'stop_alerts must reach sender.');
    assertSame([['type' => 'stop_alerts']], $second->messages, 'stop_alerts must reach all clients.');

    // Establish the shared broadcast baseline. The first cycle after a restart must
    // publish the count without replaying an alarm for pre-existing incidents.
    $first->messages = [];
    $second->messages = [];
    (Loop::$timerCallback)();
    assertSame([['alerts' => 6, 'notify' => false]], $first->messages, 'First cycle must publish without notifying.');

    $first->messages = [];
    $second->messages = [];
    (Loop::$timerCallback)();
    assertSame([], $first->messages, 'Unchanged count must not be rebroadcast.');

    $repository->count = 7;
    (Loop::$timerCallback)();
    assertSame([['alerts' => 7, 'notify' => true]], $first->messages, 'Count increase must notify.');
    assertSame([['alerts' => 7, 'notify' => true]], $second->messages, 'Increase must reach every widget.');

    $first->messages = [];
    $second->messages = [];
    $repository->count = 3;
    (Loop::$timerCallback)();
    assertSame([['alerts' => 3, 'notify' => false]], $first->messages, 'Count decrease must update without notifying.');

    // Regression: a widget connecting between polls must not consume the pending
    // change and silence the notification for the widgets already connected.
    $first->messages = [];
    $second->messages = [];
    $repository->count = 9;
    $third = new FakeConnection(3);
    $server->onOpen($third);
    assertSame([['alerts' => 9, 'notify' => false]], $third->messages, 'New widget must receive the live count.');
    assertSame([], $first->messages, 'Connecting must not push to other widgets.');

    (Loop::$timerCallback)();
    assertSame([['alerts' => 9, 'notify' => true]], $first->messages, 'Pending increase must still notify existing widgets.');
    assertSame([['alerts' => 9, 'notify' => true]], $second->messages, 'Pending increase must reach all widgets.');

    // Same guarantee for an explicit sync request.
    $first->messages = [];
    $second->messages = [];
    $repository->count = 11;
    $server->onMessage($third, '{"type":"sync"}');
    assertSame([], $first->messages, 'Sync must not push to other widgets.');

    (Loop::$timerCallback)();
    assertSame([['alerts' => 11, 'notify' => true]], $first->messages, 'Sync must not suppress the next broadcast.');

    $first->messages = [];
    $repository->failQuery = true;
    (Loop::$timerCallback)();
    assertSame([], $first->messages, 'Database failure must be contained without a bad broadcast.');

    $server->onClose($third);
    $repository->failQuery = false;
    $first->messages = [];
    $third->messages = [];
    $repository->count = 12;
    (Loop::$timerCallback)();
    assertSame([['alerts' => 12, 'notify' => true]], $first->messages, 'Broadcast continues after a client disconnects.');
    assertSame([], $third->messages, 'Closed clients must not receive broadcasts.');

    echo "WebSocketServer smoke tests passed.\n";
}
