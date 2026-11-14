import React, { type ComponentProps } from "react";
import { ModalRoot } from "@decky/ui";

export function WideModal({ children, ...props }: ComponentProps<typeof ModalRoot>) {
  return <ModalRoot {...props} bAllowFullSize modalClassName="nexus-wide-modal">
    <style>{`
      .nexus-wide-modal {
        width: calc(100vw - 32px) !important;
        max-width: none !important;
        box-sizing: border-box;
      }
    `}</style>
    {children}
  </ModalRoot>;
}
