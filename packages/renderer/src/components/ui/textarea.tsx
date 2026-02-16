import classNames from 'classnames';
import React from 'react';

import { formStyles } from './form-styles';

const Textarea = React.forwardRef<HTMLTextAreaElement, React.ComponentPropsWithoutRef<'textarea'>>(
  ({ className, ...props }, ref) => (
    <textarea
      ref={ref}
      className={classNames(formStyles.textarea, className)}
      {...props}
    />
  ),
);
Textarea.displayName = 'Textarea';

export { Textarea };
