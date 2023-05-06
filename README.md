# SEE-Backend
This repository contains the Node.js server that serves as the backend for our SEE (Sensory Enhancing Eyewear) project. 
The server implements a basic SFU one-to-many architecture, and runs YOLOv5 for object recognition on the broadcaster's stream.

## Installation
Run `npm install` inside the root directory to install all necessary packages.

## Running the server
Start the server by running `node server.js` in the root directory. By default, the server will run on port 8080 and will not use Turn Servers. To specify the port number and/or TurnServer usage, you can pass the -p flag for port number, and --ts flag for TurnServer (boolean). For example, `node server.js -p 4000 --ts` true runs the server on port 4000 and enables TURN Servers. You can also replace `node` with `nodemon` to automatically restart the server on saving changes.

### Running locally vs over-the-network
#### Local Streaming
You can run the server locally (i.e localhost), and you will be able to start broadcasting and viewing the stream on your own machine. Streaming locally (within the local network) does not require TURN Servers, so you can just run `node server.js -p <your_port_num>. To start the broadcast, head to http://localhost:8080. To view the stream, head to http://localhost:8080/viewer. It is advised not to use TURN servers while streaming locally as bandwidth via TURN servers is limited.

#### Over-the-network Streaming
To broadcast from a device on network A and view the stream from network B, you will need to download [ngrok](https://ngrok.com/download) and enable TURN servers. Ngrok allows you to expose a web server running on your local machine to the internet, and will generate a URL to access your webserver. Begin by opening the ngrok terminal, and run `ngrok http <your_port_num>`. Run your server as normal, then access the broadcasting/streaming page via the link generated. Again, make sure your pass the --ts true flag to enable TURN servers, otherwise streaming will not work.
