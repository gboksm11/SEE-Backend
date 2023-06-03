// The client.js file is the script running on the client.html webpage running on SEE. It starts a webrtc
// connection to the YOLO server, which would livestream video feed from the SEE glasses to the YOLO server.

// List of ICE servers used to establish cross-network webrtc connection
const iceServers = [
    {
      urls: "turn:a.relay.metered.ca:80",
      username: "fdd847241ab7b147627153c0",
      credential: "0QPoad1AE+/izw2H",
    },
    {
      urls: "turn:a.relay.metered.ca:80?transport=tcp",
      username: "fdd847241ab7b147627153c0",
      credential: "0QPoad1AE+/izw2H",
    },
    {
      urls: "turn:a.relay.metered.ca:443",
      username: "fdd847241ab7b147627153c0",
      credential: "0QPoad1AE+/izw2H",
    },
    {
      urls: "turn:a.relay.metered.ca:443?transport=tcp",
      username: "fdd847241ab7b147627153c0",
      credential: "0QPoad1AE+/izw2H",
    },

      { 
        "urls": "turn:TURN_IP?transport=tcp",
        "username": "TURN_USERNAME",
        "credential": "TURN_CREDENTIALS"
      }
];

let socket = null;

// automatically establish a webrtc connection with YOLO server
// on window load and start streaming video/audio
window.onload = async() => {
    console.log("window loaded");
    setUpSocket();
    await delay(2000);
    start();
}


// get DOM elements for debugging connection state
var dataChannelLog = document.getElementById('data-channel'),
    iceConnectionLog = document.getElementById('ice-connection-state'),
    iceGatheringLog = document.getElementById('ice-gathering-state'),
    signalingLog = document.getElementById('signaling-state');

// webrtc peer connection
var pc = null;

// flag indicating whether or not to use TURN servers
let USE_TURN_SERVERS = false;

// establish socket connection to YOLO server, used to handle ICE candidate
// trickling as well as configuring use of TURN servers
function setUpSocket() {
    socket = io();

    socket.on('connect', () => {
        console.log('Connected to server');
        socket.emit("broadcaster");
    });
    
    socket.on('disconnect', () => {
        console.log('Disconnected from server');
    });

    socket.on("useTurnServers", (useTurnServers) => {
        console.log(`use turn servers? ${useTurnServers}`);
        USE_TURN_SERVERS = useTurnServers;
    })

    socket.on("sw-detect", (data) => {

        [hours, minutes, seconds] = getCurrentTime();
        dataChannelLog.textContent += `< ${data.sw_state} : ${hours}:${minutes}:${seconds} \n`;
        const elem = document.getElementById("data-channel");
        elem.scrollTop = elem.scrollHeight;
    });
}

// creates a new webrtc connection
function createPeerConnection() {
    var config = {
        sdpSemantics: 'unified-plan'
    };

    if (USE_TURN_SERVERS) {
        config.iceServers = iceServers
    }

    pc = new RTCPeerConnection(config);

    // renegotiate peer connection with viewer's audio track
    socket.on("offer", async(message) => {
        console.log("RECEIVING NEW PEER OFFER FROM SERVER");
        console.log(pc.signalingState);
        await pc.setRemoteDescription(message.description);
        await pc.setLocalDescription(await pc.createAnswer());
        socket.emit("answer", {description: pc.localDescription});
    })

    pc.onicecandidate = (e) => {
        if (e.candidate != null) {
            socket.emit("icecandidate", e.candidate);
        } else {
            console.log("ICE gathering complete");
        }
    }

    socket.on("icecandidate", (candidate) => {
        console.log(`received ice candidate from server`);
        pc.addIceCandidate(candidate);
    })

    // register some listeners to help debugging
    pc.addEventListener('icegatheringstatechange', function() {
        iceGatheringLog.textContent += ' -> ' + pc.iceGatheringState;
    }, false);
    iceGatheringLog.textContent = pc.iceGatheringState;

    pc.addEventListener('iceconnectionstatechange', function() {
        iceConnectionLog.textContent += ' -> ' + pc.iceConnectionState;
        if (pc.iceConnectionState == "disconnected") {
            console.log("renegotiating");
            location.reload();
        }
    }, false);
    iceConnectionLog.textContent = pc.iceConnectionState;

    pc.addEventListener('signalingstatechange', function() {
        signalingLog.textContent += ' -> ' + pc.signalingState;
    }, false);
    signalingLog.textContent = pc.signalingState;

    // connect audio / video
    pc.addEventListener('track', function(evt) {
        console.log(evt.track.id);
        if (evt.track.kind == 'video')
            document.getElementById('video').srcObject = evt.streams[0];
        else {
            console.log("AUDIOOOOOOOOOOOOO");
            console.log(evt.streams);
            document.getElementById('audio').srcObject = evt.streams[0];
        }

    });

    return pc;
}

// creates an offer for the webrtc connection and sends it to the YOLO server
// receives an answer from the server in order to establish the connection
function negotiate() {
    console.log("creating offer...");
    return pc.createOffer().then(function(offer) {
        return pc.setLocalDescription(offer);
    }).then(function() {
        // wait for ICE gathering to complete
        console.log("Gathering ICEEEE");
        return new Promise(function(resolve) {
                resolve();
        });
    }).then(function() {
        var offer = pc.localDescription;
        var codec;

        // codec = document.getElementById('audio-codec').value;
        // if (codec !== 'default') {
        //     offer.sdp = sdpFilterCodec('audio', codec, offer.sdp);
        // }

        codec = document.getElementById('video-codec').value;
        if (codec !== 'default') {
            offer.sdp = sdpFilterCodec('video', codec, offer.sdp);
        }

        document.getElementById('offer-sdp').textContent = offer.sdp;
        console.log('fetching...');
        console.log(socket);
        return fetch('/offer', {
            body: JSON.stringify({
                sdp: offer.sdp,
                type: offer.type
            }),
            headers: {
                'Content-Type': 'application/json'
            },
            method: 'POST'
        });
    }).then(function(response) {
        console.log("received offer");
        return response.json();
    }).then(function(answer) {
        document.getElementById('answer-sdp').textContent = answer.sdp;
        return pc.setRemoteDescription(answer);
    }).catch(function(e) {
        alert(e);
    });
}

// creates a webrtc connection, appends local video/audio tracks to the connection
// and begins negotiation with YOLO server to establish a connection
function start() {
    document.getElementById('start').style.display = 'none';

    pc = createPeerConnection();

    var time_start = null;

    function current_stamp() {
        if (time_start === null) {
            time_start = new Date().getTime();
            return 0;
        } else {
            return new Date().getTime() - time_start;
        }
    }

    var constraints = {
        audio: false,
        video: true
    };

    var resolution = document.getElementById('video-resolution').value;
    if (resolution) {
        resolution = resolution.split('x');
        constraints.video = {
            width: parseInt(resolution[0], 0),
            height: parseInt(resolution[1], 0)
            //width: 640,
            //height: 640,
        };
    } else {
        constraints.video = {facingMode: 'environment'};
    }

    if (constraints.audio || constraints.video) {

        navigator.mediaDevices.getUserMedia(constraints).then(function(stream) {
            stream.getTracks().forEach(function(track) {
                console.log(`Adding my tracks, this track =`);
                console.log(track);
                pc.addTrack(track, stream);
            });
            return negotiate();
        }, function(err) {
            alert('Could not acquire media: ' + err);
        });
    } else {
        negotiate();
    }

    document.getElementById('stop').style.display = 'inline-block';
}

function stop() {
    document.getElementById('stop').style.display = 'none';

    // close transceivers
    if (pc.getTransceivers) {
        pc.getTransceivers().forEach(function(transceiver) {
            if (transceiver.stop) {
                transceiver.stop();
            }
        });
    }

    // close local audio / video
    pc.getSenders().forEach(function(sender) {
        sender.track.stop();
    });

    // close peer connection
    setTimeout(function() {
        pc.close();
    }, 500);
} 

function sdpFilterCodec(kind, codec, realSdp) {
    var allowed = []
    var rtxRegex = new RegExp('a=fmtp:(\\d+) apt=(\\d+)\r$');
    var codecRegex = new RegExp('a=rtpmap:([0-9]+) ' + escapeRegExp(codec))
    var videoRegex = new RegExp('(m=' + kind + ' .*?)( ([0-9]+))*\\s*$')
    
    var lines = realSdp.split('\n');

    var isKind = false;
    for (var i = 0; i < lines.length; i++) {
        if (lines[i].startsWith('m=' + kind + ' ')) {
            isKind = true;
        } else if (lines[i].startsWith('m=')) {
            isKind = false;
        }

        if (isKind) {
            var match = lines[i].match(codecRegex);
            if (match) {
                allowed.push(parseInt(match[1]));
            }

            match = lines[i].match(rtxRegex);
            if (match && allowed.includes(parseInt(match[2]))) {
                allowed.push(parseInt(match[1]));
            }
        }
    }

    var skipRegex = 'a=(fmtp|rtcp-fb|rtpmap):([0-9]+)';
    var sdp = '';

    isKind = false;
    for (var i = 0; i < lines.length; i++) {
        if (lines[i].startsWith('m=' + kind + ' ')) {
            isKind = true;
        } else if (lines[i].startsWith('m=')) {
            isKind = false;
        }

        if (isKind) {
            var skipMatch = lines[i].match(skipRegex);
            if (skipMatch && !allowed.includes(parseInt(skipMatch[2]))) {
                continue;
            } else if (lines[i].match(videoRegex)) {
                sdp += lines[i].replace(videoRegex, '$1 ' + allowed.join(' ')) + '\n';
            } else {
                sdp += lines[i] + '\n';
            }
        } else {
            sdp += lines[i] + '\n';
        }
    }

    return sdp;
}

function escapeRegExp(string) {
    return string.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); // $& means the whole matched string
}

// generates a delay of x ms
function delay(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

// fetches the current time in HH:MM:SS format
function getCurrentTime() {
    let now = new Date();
    let hours = now.getHours();
    let minutes = now.getMinutes();
    let seconds = now.getSeconds();
    return [hours, minutes, seconds];
}
