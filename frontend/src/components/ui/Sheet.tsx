import { ModalFrame, type DialogProps } from './Dialog';

export function Sheet(props: DialogProps) {
  return <ModalFrame {...props} side="right" />;
}
