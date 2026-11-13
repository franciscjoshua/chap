// src/p2pDm.ts
import * as Y from 'yjs';
import { IndexeddbPersistence } from 'y-indexeddb';
import { WebrtcProvider } from 'y-webrtc';

export interface DmMessage {
  id: string;
  senderKey: string;
  text: string;
  timestamp: number;
}

export interface PeerProfile {
  username: string;
  bio: string;
  avatar: string;
}

export class P2PDMSession {
  doc: Y.Doc;
  persistence: IndexeddbPersistence;
  provider: WebrtcProvider;
  messagesArray: Y.Array<DmMessage>;
  profilesMap: Y.Map<PeerProfile>;

  constructor(myPublicKey: string, friendPublicKey: string, onUpdate: () => void) {
    // Deterministic room name so both friends land in the exact same P2P tunnel
    const sortedPair = [myPublicKey.toLowerCase(), friendPublicKey.toLowerCase()].sort().join('-');
    const roomName = `chap-p2p-dm-${sortedPair}`;

    this.doc = new Y.Doc();
    this.messagesArray = this.doc.getArray<DmMessage>('messages');
    this.profilesMap = this.doc.getMap<PeerProfile>('profiles');

    // Save DMs locally on this device
    this.persistence = new IndexeddbPersistence(roomName, this.doc);

    // Connect directly to friend P2P
    this.provider = new WebrtcProvider(roomName, this.doc, {
      signaling: ['ws://localhost:4444']
    });

    this.messagesArray.observe(onUpdate);
    this.profilesMap.observe(onUpdate);
  }

  // Push our latest avatar & username into the P2P session so our friend sees it
  publishMyProfile(myPublicKey: string, profile: PeerProfile) {
    this.profilesMap.set(myPublicKey, profile);
  }

  sendMessage(myPublicKey: string, text: string) {
    this.messagesArray.push([{
      id: crypto.randomUUID(),
      senderKey: myPublicKey,
      text: text.trim(),
      timestamp: Date.now()
    }]);
  }

  destroy() {
    this.provider.destroy();
    this.persistence.destroy();
    this.doc.destroy();
  }
}
