const express = require('express');
const path = require("path");
const app = express();
const bodyParser = require('body-parser');
const webrtc = require("wrtc");
const http = require('http');
const server = http.createServer(app);
const { Server } = require("socket.io");
const io = new Server(server);
const { RTCVideoSink } = require('wrtc').nonstandard;
const tf = require('@tensorflow/tfjs-node-gpu');
const { labels } = require("./constants/labels.js");
const { iceServers } = require("./constants/iceServers.js");
const { printAttributes, i420ToCanvas } = require("./utils/utils.js");
const yargs = require('yargs/yargs');
const { hideBin } = require('yargs/helpers');

// Parse command line arguments with yargs
const argv = yargs(hideBin(process.argv))
  .usage('Usage: $0 -p [num] -ts [boolean]')
  .option('port', {
    alias: 'p',
    type: 'number',
    default: 8080,
    description: 'Port to run the server on',
  })
  .option('useTurnServers', {
    alias: 'ts',
    type: 'boolean',
    default: false,
    description: 'Enable or disable the use of TURN servers',
  })
  .check((argv) => {
    if (isNaN(argv.port)) {
      throw new Error('Port must be a number');
    }
    return true;
  })
  .help('h')
  .alias('h', 'help')
  .argv;

const PORT = argv.port;
const USE_TURN_SERVERS = argv.useTurnServers;
console.log(USE_TURN_SERVERS);

// stores broadcaster's track, used to forward track to viewers
let senderStream;

// yolov5 model
let loaded_model;

// socket connected to Rasp Pi Browser to enable ICE handshaking and connection establishment
let seeSocket;

// socket connected to Rasp Pi Python app to relay detections
let seeRaspPi;

// stores viewer sockets by socket.id
let viewers = {};

// used to space out detections
let x = 0;

app.use('/viewer', express.static('public/consumer.html'));
app.use(express.static('public'));
app.use(bodyParser.json());
app.use(bodyParser.urlencoded({ extended: true }));

app.use((req, res, next) => {
    res.header('Access-Control-Allow-Origin', '*');
    res.header('Access-Control-Allow-Headers', 'Origin, X-Requested-With, Content-Type, Accept');
    next();
  });

/*
  HANDLE SOCKET CONNECTIONS
  THREE TYPES OF CONNECTIONS:
   - BROADCASTER: Rasp Pi Cam (from browser)
   - VIEWER: viewer connected to cam stream
   - RASP-PI: Rasp Pi Python app (to get detections)
*/
io.on('connection', (socket) => {

    socket.emit("useTurnServers", USE_TURN_SERVERS);

    // if socket emits broadcaster event, they are the broadcasting socket
    socket.on("broadcaster", () => {
        console.log('broadcaster connected');
        seeSocket = socket;
    })

    // detect client receiving detections
    socket.on("see_rasp_pi", () => {
        console.log('Raspberry Pi Connected');
        seeRaspPi = socket;
    })

    // if socket emits viewer event, they are the viewing socket
    socket.on("viewer", () => {
        console.log('viewer connected');
        viewers[socket.id] = socket;
    })

    socket.on('disconnect', () => {
        console.log('user disconnected');
        seeSocket = null;
    });
});

// handles request from viewer to establish webrtc connection and view broadcaster's stream
app.post("/consumer", async ({ body }, res) => {
    const { sdp, type, client_id } = body;
    console.log(`viewer ${client_id} reached consumer endpoint`);

    if (!client_id) {
        res.status(400).send({msg: "Client not connected to server"});
        return;
    }

    // broadcast already started from SEE glasses
    if (senderStream && sdp && type) {
        const peer = new webrtc.RTCPeerConnection({
            iceServers: iceServers
        });
    
        peer.onicecandidate = e => {
            if (e.candidate != null) {
                viewers[client_id].emit("icecandidate", e.candidate);
            }
        }
    
        viewers[client_id].on("icecandidate", (candidate) => {
            peer.addIceCandidate(candidate);
        })
    
        const desc = new webrtc.RTCSessionDescription({sdp: sdp, type: type});
        await peer.setRemoteDescription(desc);
        senderStream.getTracks().forEach(track => peer.addTrack(track, senderStream));
        const answer = await peer.createAnswer();
        await peer.setLocalDescription(answer);
        const payload = {
            sdp: peer.localDescription.sdp,
            type: peer.localDescription.type
        }
        res.status(200).json(payload);
    } else {
        res.status(400).send({msg: "Error connecting to stream: stream has not started yet"});
    }

});

// handles request from broadcaster to establish webrtc connection and start broadcasting to the server
app.post('/offer', async ({ body }, res) => {
    console.log(`broadcaster reached offer endpoint`);
    if (seeSocket) {
        const {sdp, type} = body;
        const peer = new webrtc.RTCPeerConnection({
            iceServers: iceServers
        });
    
        peer.onicecandidate = e => {
            if (e.candidate != null) {
                seeSocket.emit("icecandidate", e.candidate);
            }
        }
    
        seeSocket.on("icecandidate", (candidate) => {
            peer.addIceCandidate(candidate);
        })
    
    
        peer.ontrack = (e) => handleTrackEvent(e, peer);
        const desc = new webrtc.RTCSessionDescription({sdp: sdp, type: type});
        await peer.setRemoteDescription(desc);
        const answer = await peer.createAnswer();
        await peer.setLocalDescription(answer);
        const payload = {
            sdp: peer.localDescription.sdp,
            type: peer.localDescription.type
        }
    
        res.json(payload);
    } else {
        res.status(400).send({msg: "Error connecting to RaspPi: Socket connection not established"});
    }

    console.log("sent offer to broadcaster");
});

// receives track from broadcaster and handles it
function handleTrackEvent(e, peer) {
    console.log(e.track.id);
    senderStream = e.streams[0];
    const track = e.track;
    const sink = new RTCVideoSink(track);

    // triggered on receiving a frame from the broadcaster's video stream
    sink.onframe = async ({frame}) => {
        x++;
        if (x % 70 == 0) {

            const canvas = await i420ToCanvas(frame.data, frame.width, frame.height);

            // working with yolov7 web model
            tf.engine().startScope();
            // const input = tf.tidy(() => {
            //     const img = tf.image.resizeBilinear(tf.browser.fromPixels(canvas), [640, 640]).div(255.0).transpose([2, 0, 1]).expandDims(0);
            //     return img;
            // })

            // yolov5/v8 web model
            const input = tf.tidy(() => {
                const img = tf.image.resizeBilinear(tf.browser.fromPixels(canvas), [640, 640]).div(255.0).expandDims(0);
                return img;
            })

            let predictions = await loaded_model.executeAsync(input);
            
            yolov5OutputToDetections(predictions);
            tf.engine().endScope();
        }
    }
};

function yolov5OutputToDetections(res) {

    const [boxes, scores, classes, valid_detections] = res;
    const boxes_data = boxes.dataSync();
    const scores_data = scores.dataSync();
    const classes_data = classes.dataSync();
    const valid_detections_data = valid_detections.dataSync()[0];

    tf.dispose(res)

    const detections = [];

    for (var i = 0; i < valid_detections_data; ++i) {

        //let [x1, y1, x2, y2] = boxes_data.slice(i * 4, (i + 1) * 4);

        const klass = labels[classes_data[i]];
        const score = scores_data[i].toFixed(2);

        const classIsInArray = detections.some(detection => detection.class == klass);

        if (!classIsInArray) {
            detections.push({
                class: klass,
                count: 1,
                confidence: [score]
            });
        } else {
            const detectionIndex = detections.findIndex(detection => detection.class == klass);
            detections[detectionIndex].count++;
            detections[detectionIndex].confidence.push(score);
        }
    }

    // print detections
    //detections.map(detection => printAttributes(detection));
    console.log(detections);
    console.log();
    console.log();
    if (seeRaspPi) {
        seeRaspPi.emit('detections', JSON.stringify(detections));
    }

    
}

async function loadYolo() {
    loaded_model = await tf.loadGraphModel(`http://localhost:${PORT}/yolov5m_web_model/model.json`);
    console.log(`YOLOv5 model loaded`);
}

server.listen(PORT, () => {
    console.log(`Server started at port ${PORT} | Turn Servers ${USE_TURN_SERVERS ? 'enabled' : 'disabled'}`);
    loadYolo();
});