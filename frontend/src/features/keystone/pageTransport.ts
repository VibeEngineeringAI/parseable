import { createNativeKeystonePageTransport } from '../../lib/keystone/nativeTransport';
import type { KeystonePageTransport } from './pageContract';

export function defaultKeystonePageTransport(): KeystonePageTransport {
  return createNativeKeystonePageTransport();
}
