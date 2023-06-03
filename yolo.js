// The YOLO.js file represents the main server that communicates with the SEE glasses.
// The server first handles establishing a webrtc connection between the client (SEE glasses)
// and the server. Upon successful connection, it runs the YOLO model on video frames from the
// video stream, and relays detections to the SEE glasses. Upon switching to street mode,
// the server also runs the sidewalk detection model on the video frames. Finally, the server
// acts as an intermediary between the client and the webapp, relaying settings updates to the
// SEE glasses, and learn face requests from the glasses to the web app. 

// import libraries used
const express = require('express');
const path = require("path");
const app = express();
const bodyParser = require('body-parser');
const webrtc = require("wrtc");
const http = require('http');
const server = http.createServer(app);
const { Server } = require("socket.io");
const io = new Server(server, {
    cors: {
        origin: '*',
    }
});
const cors = require('cors');
const { RTCVideoSink } = require('wrtc').nonstandard;
const tf = require('@tensorflow/tfjs-node-gpu');
const { labels } = require("./constants/labels.js");
const { iceServers } = require("./constants/iceServers.js");
const { printAttributes, i420ToCanvas, saveAsJpg, canvasToPng } = require("./utils/utils.js");
const yargs = require('yargs/yargs');
const { hideBin } = require('yargs/helpers');
const { PythonShell } = require('python-shell');
const { trace } = require('console');
const fs = require('fs');

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

// stores broadcaster's audio track
let senderAudio;

// yolov5 model
let loaded_model;

// socket connected to Rasp Pi Browser to enable ICE handshaking and connection establishment
let seeSocket;

// ID of SEE webrtc client
let seeSocketId;

// socket connected to Rasp Pi object recognition service
let seeRaspPi;

// socket connected to Rasp Pi sidewalk detection service
let sidewalkSocket;

// id of sidewalk detection service socket
let sidewalkSocketId;

// webapp socket
let reactSocket;

// webapp handler socket (running on SEE glasses)
let raspiWebHandlerSocket;

// the most recent frame received by the server
let currentFrame = null;

// stores viewer sockets by socket.id
let viewers = {};

// used to space out detections
let x = 0;

// python shell
let python;

// list of all webrtc connections
let peerConnections = {};

// handle relevant middleware
app.use('/viewer', express.static('public/consumer.html'));
app.use(express.static('public'));
app.use(bodyParser.json());
app.use(bodyParser.urlencoded({ extended: true }));
app.use(cors(
    {
        origin: '*'
    }
));

app.use((req, res, next) => {
    res.header('Access-Control-Allow-Origin', '*');
    res.header('Access-Control-Allow-Headers', 'Origin, X-Requested-With, Content-Type, Accept');
    next();
  });

/*
  HANDLE SOCKET CONNECTIONS
  SIX TYPES OF CONNECTIONS:
   - BROADCASTER: Rasp Pi Cam (from browser)
   - VIEWER: viewer connected to cam stream
   - RASP-PI: Rasp Pi Python app (to get detections)
   - WEB_APP_HANDLER: Rasp Pi Python app (to relay webapp / see requests)
   - REACT_APP: (to relay web app requests)
   - SIDEWALK: relays sidewalk detections
*/
io.on('connection', (socket) => {

    socket.emit("useTurnServers", USE_TURN_SERVERS);

    // if socket emits broadcaster event, they are the broadcasting socket
    socket.on("broadcaster", () => {
        console.log('broadcaster connected');
        seeSocket = socket;
        seeSocketId = socket.id
    })

    // detect client receiving detections
    socket.on("see_rasp_pi", () => {
        console.log('Object Recognition Service connected');
        seeRaspPi = socket;
    });

    // if socket emits sidewalk_detector, they are sidewalk detections socket
    socket.on("sidewalk_detector", () => {
        console.log('Sidewalk Detection Service connected')
        sidewalkSocket = socket;
        sidewalkSocketId = socket.id;
    });

    // if socket emits viewer event, they are the viewing socket
    socket.on("viewer", () => {
        console.log('viewer connected');
        viewers[socket.id] = socket;
    });

    // if socket emits react app event, they are web app
    // handle relaying see-requests (web app requests to configure SEE settings)
    socket.on("react-app-real", () => {
        console.log(`react app connected, id = ${socket.id}`);
        reactSocket = socket;

        reactSocket.on("see-request", async(data, callback) => {

            if (raspiWebHandlerSocket != null) {
                raspiWebHandlerSocket.timeout(5000).emit("see-request", data, (err, response_code) => {
                    if (err) {
                        callback(500);
                    } else {
                        callback(response_code);
                    }
                })
            } else {
                //send back that request failed
                callback(500);
            }
        });


        // handle yolo-requests (requests sent from webapp to server, i.e getting all learned faces)
        reactSocket.on("yolo-request", async(callback) => {
            const facesDirectory = path.join(__dirname, "public", "faces");

            fs.readdir(facesDirectory, (err, files) => {
                if (err) {
                  return callback(null, 500);
                }
            
                // Send the file names as the response
                callback(files, 200);
              });
        });
    });


    // if socket emits web-app-handler event, they are web app handler
    socket.on("web-app-handler", () => {
        console.log("web app handler connected");
        raspiWebHandlerSocket = socket;

        // handles request made by glasses to learn a new face. Sends request to web app, and waits for response.
        // On response, saves face as image with corresponding face id and string (name), and sends back name
        // to SEE to be stored as audio. Once response is received by SEE, face is successfully learned.
        raspiWebHandlerSocket.on("learn-face", (data, callback) => {
            if (reactSocket != null) {
                if (currentFrame) {
                    const userPic = {...currentFrame}
                    reactSocket.timeout(20000).emit("learn-face", userPic, (err, name, response_code) => {
                        if (err) {
                            callback(null, 500);
                        } else {
                            if (response_code == 500) {
                                callback(null, 500);
                                return;
                            }
                            i420ToCanvas(userPic.data, userPic.width, userPic.height)
                                .then(canvas => canvasToPng(canvas, `${data}_${name}.png`))
                                .then(success => callback(name, 200))
                                .catch(err => {
                                    console.log(`Err saving image, ${err}`);
                                    callback(null, 500)
                                });
                        }
                    });
                }

            } else {
                callback(null, 500);
            }
        });

    });


    socket.on('disconnect', () => {

        if (socket.id == seeSocketId) {
            seeSocket = null;
            console.log('Object Recognition Service disconnected');
        } else if (socket.id == sidewalkSocketId) {
            sidewalkSocket = null;
            console.log('Sidewalk Recognition Service disconnected');
        } else {
            console.log(`user ${socket.id} disconnected`);
            if (peerConnections[socket.id]) {
                console.log("closing viewer pc");
                peerConnections[socket.id].close();
            }
        }
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

        peerConnections[client_id] = peer;
    
        peer.onicecandidate = e => {
            viewers[client_id].emit("icecandidate", e.candidate);
        }

        peer.ontrack = (e) => {
            console.log("tracks coming from peer");
            console.log(`track id = ${e.track.id}, track kind = ${e.track.kind}`);
            peerConnections["broadcaster-pc"].addTrack(e.track, senderAudio);
            //peer.addTrack(e.track);
        }
    
        viewers[client_id].on("icecandidate", (candidate) => {
            peer.addIceCandidate(candidate);
        })
    
        const desc = new webrtc.RTCSessionDescription({sdp: sdp, type: type});
        await peer.setRemoteDescription(desc);
        senderStream.getTracks().forEach(track => {
            console.log(`id = ${track.id}, kind = ${track.kind}`);
            peer.addTrack(track, senderStream)
        });
        //senderAudio.getTracks().forEach(track => peer.addTrack(track, senderAudio));
        const answer = await peer.createAnswer();
        await peer.setLocalDescription(answer);
        const payload = {
            sdp: peer.localDescription.sdp,
            type: peer.localDescription.type
        }
        console.log(`sending to viewer`)
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

        peerConnections["broadcaster-pc"] = peer;
    
        peer.onicecandidate = e => {
            if (e.candidate != null) {
                seeSocket.emit("icecandidate", e.candidate);
            }
        }

        peer.onnegotiationneeded = async(e) => {
            console.log("SENDING NEW NEGOTIATION FOR CLIENT PEER");
            await peer.setLocalDescription(await peer.createOffer());
            seeSocket.emit("offer", {description: peer.localDescription});
        }

        seeSocket.on("answer", async(message) => {
            console.log("RECEIVED ANSWER FOR NEW NEGOTIATION");
            if (peer.signalingState != "stable") {
                await peer.setRemoteDescription(message.description);
                console.log("done");
            }
        })
    
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
    
    console.log("Receiving tracks from client");
    console.log(`track id = ${e.track.id} and kind = ${e.track.kind}`);

    const track = e.track;
    if (track.kind == "video") {
        senderStream = e.streams[0];
        const sink = new RTCVideoSink(track);
    
        // triggered on receiving a frame from the broadcaster's video stream
        // on receiving a frame, turn the frame into an rgb frame, resize it,
        // and insert into the YOLO model. Get the predictions and send back
        // to SEE. Additionally, send frames to sidewalk detection model running
        // in a python environment.
        sink.onframe = async ({frame}) => {
            currentFrame = frame;
            x++;
            python.send(`${frame.width},${frame.height};` + Buffer.from(frame.data).toString('base64'));
            if (x % 70 == 0) {
                const canvas = await i420ToCanvas(frame.data, frame.width, frame.height);
    
                tf.engine().startScope();
                const input = tf.tidy(() => {
                    const img = tf.image.resizeBilinear(tf.browser.fromPixels(canvas), [640, 640]).div(255.0).expandDims(0);
                    return img;
                })
    
                let predictions = await loaded_model.executeAsync(input);
                
                yolov5OutputToDetections(predictions);
                tf.engine().endScope();
            }
        }
    } else {
        senderAudio = e.streams[0];
    }

};

// Given the output of the YOLO model, parse the output as detections with
// the different classes detected, the count of each class, and the confidence
// levels. Send the parsed output to SEE.
function yolov5OutputToDetections(res) {

    const [boxes, scores, classes, valid_detections] = res;
    const boxes_data = boxes.dataSync();
    const scores_data = scores.dataSync();
    const classes_data = classes.dataSync();
    const valid_detections_data = valid_detections.dataSync()[0];

    tf.dispose(res)

    const detections = [];

    for (var i = 0; i < valid_detections_data; ++i) {
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
    console.log(detections);
    console.log();
    console.log();
    if (seeRaspPi) {
        seeRaspPi.emit('detections', JSON.stringify(detections));
    }
}

// load the YOLO model. Spawn a python shell in order to communicate with the sidewalk detection model
// running in a python environment. Handles outputs of the sidewalk detection model by sending them
// to SEE
async function loadYolo() {
    loaded_model = await tf.loadGraphModel(`http://localhost:${PORT}/yolov5m_web_model/model.json`);
    console.log(`YOLOv5 model loaded`);

    const scriptPath = 'C:/Users/Ghaith/Desktop/CSE 475/Test Apps/outdoor-blind-navigation/see.py'

    const options = {
        mode: 'text',
        pythonOptions: ['-u'],
        stdio: 'pipe',
        scriptPath: path.dirname(scriptPath),
      };
    
    python = new PythonShell(path.basename(scriptPath), options);
    console.log('python shell loaded');

    python.on('message', (message) => {
        if (sidewalkSocket != null || true) {
            try {
                const msg = JSON.parse(message);
                sidewalkSocket.emit("detect_sidewalk", msg);
                console.log(msg);
            } catch (error) {
                // do nothing
                //console.log(error);
            }
        }

    });

    python.on('error', (error) => {
        console.error(`Error in Python script: ${error}`);
      });
}

// Start the server, load the models, and listen at specified port.
server.listen(PORT, () => {
    console.log(`Server started at port ${PORT} | Turn Servers ${USE_TURN_SERVERS ? 'enabled' : 'disabled'}`);
    loadYolo();
});