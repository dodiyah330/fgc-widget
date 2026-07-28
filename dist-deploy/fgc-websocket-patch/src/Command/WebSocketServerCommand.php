<?php

namespace App\Command;

use App\WebSocketServer;
use Ratchet\Http\HttpServer;
use Ratchet\Server\IoServer;
use Ratchet\WebSocket\WsServer;
use React\EventLoop\Loop;
use React\Socket\SocketServer;
use Symfony\Component\Console\Command\Command;
use Symfony\Component\Console\Input\InputInterface;
use Symfony\Component\Console\Output\OutputInterface;

class WebSocketServerCommand extends Command
{
    protected static $defaultName = 'app:websocket-server';

    private WebSocketServer $webSocketServer;

    public function __construct(WebSocketServer $webSocketServer)
    {
        $this->webSocketServer = $webSocketServer;
        parent::__construct();
    }

    protected function execute(InputInterface $input, OutputInterface $output): int
    {
        $port = $this->getApplication()->getKernel()->getContainer()->getParameter('websocket_server_port');

        $loop = Loop::get();

        $socket = new SocketServer('0.0.0.0:' . $port, [], $loop);

        $wsServer = new WsServer($this->webSocketServer);
        $wsServer->enableKeepAlive($loop, 30); // ping cada 30s a nivel de protocolo

        $server = new IoServer(
            new HttpServer($wsServer),
            $socket,
            $loop
        );

        $output->writeln('Servidor WebSocket iniciado en el puerto ' . $port);
        $loop->run();

        return Command::SUCCESS;
    }
}