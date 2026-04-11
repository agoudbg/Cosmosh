import classNames from 'classnames';
import React from 'react';

import { formStyles } from './form-styles';

type ButtonVariant = 'default' | 'ghost' | 'icon' | 'ghostIcon' | 'inverted';
type ButtonPadding = 'default' | 'mid' | 'wide';

type ButtonProps = React.ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: ButtonVariant;
  padding?: ButtonPadding;
};

const Button = React.forwardRef<HTMLButtonElement, ButtonProps>(
  ({ className, variant = 'default', padding = 'default', type = 'button', ...props }, ref) => {
    const isIconVariant = variant === 'icon' || variant === 'ghostIcon';

    return (
      <button
        ref={ref}
        type={type}
        data-button-variant={variant}
        data-button-padding={padding}
        className={classNames(
          variant === 'ghost'
            ? formStyles.buttonGhost
            : variant === 'ghostIcon'
              ? formStyles.buttonGhost
              : variant === 'inverted'
                ? formStyles.buttonInverted
                : formStyles.button,
          isIconVariant && 'h-[34px] w-[34px] flex-shrink-0 !p-0',
          padding === 'mid' && !isIconVariant && 'px-[15px]',
          padding === 'wide' && !isIconVariant && 'px-[18px]',
          className,
        )}
        {...props}
      />
    );
  },
);
Button.displayName = 'Button';

export { Button };
