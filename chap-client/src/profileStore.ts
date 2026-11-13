import * as Y from 'yjs';
import { IndexeddbPersistence } from 'y-indexeddb';
import { WebrtcProvider } from 'y-webrtc';
import { bytesToHex, hexToBytes } from './identity';

export let ydoc = new Y.Doc();
export let profileMap = ydoc.getMap<string>('profile');
export let serversArray = ydoc.getArray<string>('servers');
export let friendsArray = ydoc.getArray<string>('friends');
export let blockedArray = ydoc.getArray<string>('blocked');
export let snapshotServersArray = ydoc.getArray<string>('snapshotServers'); // Servers allowed to hold our encrypted backup

let persistence: IndexeddbPersistence | null = null;
let webrtcProvider: WebrtcProvider | null = null;

export function connectAccountSync(publicKeyHex: string, mnemonic: string) {
  disconnectAccountSync();

  ydoc = new Y.Doc();
  profileMap = ydoc.getMap<string>('profile');
  serversArray = ydoc.getArray<string>('servers');
  friendsArray = ydoc.getArray<string>('friends');
  blockedArray = ydoc.getArray<string>('blocked');
  snapshotServersArray = ydoc.getArray<string>('snapshotServers');

  persistence = new IndexeddbPersistence(`chap-profile-${publicKeyHex}`, ydoc);

  webrtcProvider = new WebrtcProvider(`chap-sync-${publicKeyHex}`, ydoc, {
    password: mnemonic,
    signaling: ['ws://localhost:4444']
  });
}

// Encrypt the entire Yjs CRDT state using AES-GCM derived from the user's secret Private Key
export async function exportEncryptedSnapshot(privateKey: Uint8Array): Promise<string> {
  const update = Y.encodeStateAsUpdate(ydoc);
  const cryptoKey = await crypto.subtle.importKey('raw', privateKey, 'AES-GCM', false, ['encrypt']);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const encrypted = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, cryptoKey, update);
  
  const combined = new Uint8Array(iv.length + encrypted.byteLength);
  combined.set(iv, 0);
  combined.set(new Uint8Array(encrypted), iv.length);
  return bytesToHex(combined);
}

// Decrypt and merge an encrypted Yjs snapshot when logging in on an offline/new device!
export async function importEncryptedSnapshot(encryptedHex: string, privateKey: Uint8Array) {
  try {
    const combined = hexToBytes(encryptedHex);
    const iv = combined.slice(0, 12);
    const ciphertext = combined.slice(12);
    const cryptoKey = await crypto.subtle.importKey('raw', privateKey, 'AES-GCM', false, ['decrypt']);
    const decrypted = await crypto.subtle.decrypt({ name: 'AES-GCM', iv }, cryptoKey, ciphertext);
    Y.applyUpdate(ydoc, new Uint8Array(decrypted));
  } catch (e) {
    console.warn('Could not decrypt snapshot:', e);
  }
}

export function disconnectAccountSync() {
  if (webrtcProvider) {
    webrtcProvider.destroy();
    webrtcProvider = null;
  }
  if (persistence) {
    persistence.destroy();
    persistence = null;
  }
}
