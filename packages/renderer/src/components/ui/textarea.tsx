import classNames from 'classnames';
import React from 'react';

import { formStyles } from './form-styles';
import { InputContextMenuItem, useRegisterInputContextMenuItems } from './input-context-menu-registry';

type TextareaProps = React.ComponentPropsWithoutRef<'textarea'> & {
  contextMenuItems?: InputContextMenuItem[];
};

const Textarea = React.forwardRef<HTMLTextAreaElement, TextareaProps>(
  ({ className, contextMenuItems, ...props }, ref) => {
    const textareaRef = React.useRef<HTMLTextAreaElement | null>(null);

    useRegisterInputContextMenuItems(textareaRef.current, contextMenuItems);

    const setRefs = React.useCallback(
      (node: HTMLTextAreaElement | null) => {
        textareaRef.current = node;

        if (typeof ref === 'function') {
          ref(node);
          return;
        }

        if (ref) {
          ref.current = node;
        }
      },
      [ref],
    );

    return (
      <textarea
        ref={setRefs}
        className={classNames(formStyles.textarea, className)}
        {...props}
      />
    );
  },
);
Textarea.displayName = 'Textarea';

export { Textarea };
