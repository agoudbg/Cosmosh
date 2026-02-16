import classNames from 'classnames';
import React from 'react';

import { formStyles } from './form-styles';

type ButtonVariant = 'default' | 'ghost';

type ButtonProps = React.ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: ButtonVariant;
};

const Button = React.forwardRef<HTMLButtonElement, ButtonProps>(
  ({ className, variant = 'default', type = 'button', ...props }, ref) => (
    <button
      ref={ref}
      type={type}
      className={classNames(variant === 'ghost' ? formStyles.buttonGhost : formStyles.button, className)}
      {...props}
    />
  ),
);
Button.displayName = 'Button';

export { Button };
