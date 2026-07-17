import type { ReactNode } from 'react';
import { IconX } from '@tabler/icons-react';

interface Props {
  title: ReactNode;
  wide?: boolean;
  onClose: () => void;
  children: ReactNode;
  footer: ReactNode;
  /** Renders the scroll region as a <form> (so the footer's submit button, which lives inside it, triggers this) instead of a <div>. */
  onSubmit?: (e: React.FormEvent) => void;
}

// Shared modal shell (design system): translucent backdrop, white card with a
// matcha-200 hairline border, rounded-2xl corners, no shadow. Body + footer
// share one scroll container with the footer pinned via `sticky bottom-0`
// (same pattern the pre-redesign .modal-actions CSS used) so a submit button
// in the footer stays a normal descendant of the <form>. Used by AddEditForm,
// SettingsModal, and TailorModal so the three can't visually drift apart.
export function Modal({ title, wide, onClose, children, footer, onSubmit }: Props) {
  const Scroll = onSubmit ? 'form' : 'div';
  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-ink/40 backdrop-blur-[2px]"
      onClick={onClose}
    >
      <div
        className={`bg-white w-full ${wide ? 'max-w-[780px]' : 'max-w-[620px]'} max-h-[90vh] rounded-2xl border-[0.5px] border-matcha-200 flex flex-col overflow-hidden`}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="px-6 py-5 border-b border-matcha-200 flex justify-between items-center shrink-0">
          <h2 className="text-lg font-medium tracking-tight text-ink m-0">{title}</h2>
          <button type="button" onClick={onClose} className="text-ink-soft hover:text-ink" aria-label="Close">
            <IconX size={20} stroke={1.75} />
          </button>
        </div>

        <Scroll className="overflow-y-auto flex-1" {...(onSubmit ? { onSubmit } : {})}>
          <div className="px-6 py-4">{children}</div>
          <div className="sticky bottom-0 bg-white px-6 py-4 border-t border-matcha-200 flex justify-end items-center gap-3">
            {footer}
          </div>
        </Scroll>
      </div>
    </div>
  );
}
