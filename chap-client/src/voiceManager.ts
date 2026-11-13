// src/voiceManager.ts
export class VoiceManager {
  localStream: MediaStream | null = null;
  peers = new Map<string, RTCPeerConnection>();
  audioElements = new Map<string, HTMLAudioElement>();
  ws: WebSocket;
  isMuted = false;
  isDeafened = false;

  constructor(ws: WebSocket) {
    this.ws = ws;
  }

  async startLocalMic() {
    this.localStream = await navigator.mediaDevices.getUserMedia({ audio: true, video: false });
  }

  setMuted(muted: boolean) {
    this.isMuted = muted;
    if (this.localStream) {
      this.localStream.getAudioTracks().forEach(track => {
        track.enabled = !muted;
      });
    }
  }

  setDeafened(deafened: boolean) {
    this.isDeafened = deafened;
    this.audioElements.forEach(audio => {
      audio.muted = deafened;
    });
    // Deafening also mutes mic (just like Discord)
    if (deafened) {
      this.setMuted(true);
    }
  }

  private createPeerConnection(peerKey: string): RTCPeerConnection {
    if (this.peers.has(peerKey)) return this.peers.get(peerKey)!;

    const pc = new RTCPeerConnection({
      iceServers: [{ urls: 'stun:stun.l.google.com:19302' }]
    });

    if (this.localStream) {
      this.localStream.getTracks().forEach(track => pc.addTrack(track, this.localStream!));
    }

    pc.onicecandidate = (e) => {
      if (e.candidate && this.ws.readyState === WebSocket.OPEN) {
        this.ws.send(JSON.stringify({
          type: 'VOICE_SIGNAL',
          targetKey: peerKey,
          signal: { candidate: e.candidate }
        }));
      }
    };

    pc.ontrack = (e) => {
      let audio = this.audioElements.get(peerKey);
      if (!audio) {
        audio = new Audio();
        audio.autoplay = true;
        audio.muted = this.isDeafened;
        this.audioElements.set(peerKey, audio);
      }
      audio.srcObject = e.streams[0];
    };

    this.peers.set(peerKey, pc);
    return pc;
  }

  async initiateCallToPeer(peerKey: string) {
    const pc = this.createPeerConnection(peerKey);
    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);
    this.ws.send(JSON.stringify({
      type: 'VOICE_SIGNAL',
      targetKey: peerKey,
      signal: { sdp: pc.localDescription }
    }));
  }

  async handleIncomingSignal(fromKey: string, signal: any) {
    const pc = this.createPeerConnection(fromKey);
    if (signal.sdp) {
      await pc.setRemoteDescription(new RTCSessionDescription(signal.sdp));
      if (signal.sdp.type === 'offer') {
        const answer = await pc.createAnswer();
        await pc.setLocalDescription(answer);
        this.ws.send(JSON.stringify({
          type: 'VOICE_SIGNAL',
          targetKey: fromKey,
          signal: { sdp: pc.localDescription }
        }));
      }
    } else if (signal.candidate) {
      await pc.addIceCandidate(new RTCIceCandidate(signal.candidate));
    }
  }

  stop() {
    this.peers.forEach(pc => pc.close());
    this.peers.clear();
    this.audioElements.forEach(audio => {
      audio.pause();
      audio.srcObject = null;
    });
    this.audioElements.clear();
    if (this.localStream) {
      this.localStream.getTracks().forEach(t => t.stop());
      this.localStream = null;
    }
  }
}
