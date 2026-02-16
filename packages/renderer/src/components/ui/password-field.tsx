import classNames from 'classnames';
import { Eye, EyeOff } from 'lucide-react';
import React from 'react';

import { formStyles } from './form-styles';

type PasswordFieldProps = Omit<React.ComponentPropsWithoutRef<'input'>, 'type'>;

const PasswordField = React.forwardRef<HTMLInputElement, PasswordFieldProps>(({ className, ...props }, ref) => {
  const [isVisible, setIsVisible] = React.useState<boolean>(false);

  return (
    <div className="relative">
      <input
        ref={ref}
        type={isVisible ? 'text' : 'password'}
        className={classNames(formStyles.input, 'pr-10', className)}
        {...props}
      />
      <button
        type="button"
        className={formStyles.passwordToggle}
        aria-label={isVisible ? 'Hide password' : 'Show password'}
        onClick={() => setIsVisible((previous) => !previous)}
      >
        {isVisible ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
      </button>
    </div>
  );
});
PasswordField.displayName = 'PasswordField';

export { PasswordField };
