var dataChannelLog = document.getElementById('data-channel');
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

window.onload = () => {
    document.getElementById('my-button').onclick = () => {
        init();
    }
}

const socket = io();

// flag indicating whether or not to use TURN servers
let USE_TURN_SERVERS;

socket.on('connect', () => {
    console.log('Connected to server');
    socket.emit("viewer");
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
    //dataChannelLog.textContent += `< ${data.sw_state} : ${hours}:${minutes}:${seconds} \n`;
    console.log(`< ${data.sw_state} : ${hours}:${minutes}:${seconds} \n`)
   // const elem = document.getElementById("data-channel");
    //elem.scrollTop = elem.scrollHeight;
})

async function init() {
    const peer = createPeer();
    peer.addTransceiver("video", { direction: "recvonly" })
}

function createPeer() {

    var config = {
        sdpSemantics: 'unified-plan'
    };

    if (USE_TURN_SERVERS) {
        config.iceServers = iceServers
    }


    const peer = new RTCPeerConnection(config);

    peer.onicecandidate = (e) => {
        if (e.candidate != null) {
            socket.emit("icecandidate", e.candidate);
        } else {
            console.log("ICE gathering complete");
        }
    }

    socket.on("icecandidate", (candidate) => {
        console.log(`received ice candidate from server`);
        peer.addIceCandidate(candidate);
    })

    peer.ontrack = handleTrackEvent;
    peer.onnegotiationneeded = () => handleNegotiationNeededEvent(peer);

    return peer;
}

async function handleNegotiationNeededEvent(peer) {
    const offer = await peer.createOffer();
    await peer.setLocalDescription(offer);
    const payload = {
        sdp: peer.localDescription.sdp,
        type: peer.localDescription.type,
        client_id: socket.id
    };

    try {
        const { data } = await axios.post('/consumer', payload);
        const desc = new RTCSessionDescription({sdp: data.sdp, type: data.type});
        peer.setRemoteDescription(desc).catch(e => document.getElementById("err-msg").innerText = e);
        document.getElementById("err-msg").innerText = "";
    } catch (err) {
        console.log(err);
        document.getElementById("err-msg").innerText = "Could not open stream. Broadcast not started yet";
    }
}

function handleTrackEvent(e) {
    document.getElementById("video").srcObject = e.streams[0];
};

function getCurrentTime() {
    let now = new Date();
    let hours = now.getHours();
    let minutes = now.getMinutes();
    let seconds = now.getSeconds();
    return [hours, minutes, seconds];
}