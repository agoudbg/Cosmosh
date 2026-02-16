import classNames from 'classnames';
import React from 'react';

import { formStyles } from './form-styles';

const Input = React.forwardRef<HTMLInputElement, React.ComponentPropsWithoutRef<'input'>>(
  ({ className, ...props }, ref) => (
    <input
      ref={ref}
      className={classNames(formStyles.input, className)}
      {...props}
    />
  ),
);
Input.displayName = 'Input';

export { Input };
