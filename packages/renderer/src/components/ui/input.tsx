import classNames from 'classnames';
import React from 'react';

import { formStyles } from './form-styles';
import { InputContextMenuItem, useRegisterInputContextMenuItems } from './input-context-menu-registry';

type InputProps = React.ComponentPropsWithoutRef<'input'> & {
  contextMenuItems?: InputContextMenuItem[];
};

const Input = React.forwardRef<HTMLInputElement, InputProps>(({ className, contextMenuItems, ...props }, ref) => {
  const inputRef = React.useRef<HTMLInputElement | null>(null);

  useRegisterInputContextMenuItems(inputRef.current, contextMenuItems);

  const setRefs = React.useCallback(
    (node: HTMLInputElement | null) => {
      inputRef.current = node;

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
    <input
      ref={setRefs}
      className={classNames(formStyles.input, className)}
      {...props}
    />
  );
});
Input.displayName = 'Input';

export { Input };
