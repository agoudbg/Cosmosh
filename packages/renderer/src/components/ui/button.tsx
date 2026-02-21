import classNames from 'classnames';
import React from 'react';

import { formStyles } from './form-styles';

type ButtonVariant = 'default' | 'ghost' | 'icon' | 'inverted';
type ButtonPadding = 'default' | 'mid' | 'wide';

type ButtonProps = React.ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: ButtonVariant;
  padding?: ButtonPadding;
};

const Button = React.forwardRef<HTMLButtonElement, ButtonProps>(
  ({ className, variant = 'default', padding = 'default', type = 'button', ...props }, ref) => (
    <button
      ref={ref}
      type={type}
      data-button-variant={variant}
      data-button-padding={padding}
      className={classNames(
        variant === 'ghost'
          ? formStyles.buttonGhost
          : variant === 'inverted'
            ? formStyles.buttonInverted
            : formStyles.button,
        variant === 'icon' && 'w-[34px] h-[34px] flex-shrink-0 !p-0',
        padding === 'mid' && variant !== 'icon' && 'px-[15px]',
        padding === 'wide' && variant !== 'icon' && 'px-[18px]',
        className,
      )}
      {...props}
    />
  ),
);
Button.displayName = 'Button';

export { Button };
