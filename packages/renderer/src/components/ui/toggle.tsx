import * as TogglePrimitive from '@radix-ui/react-toggle';
import classNames from 'classnames';
import React from 'react';

import { formStyles } from './form-styles';

/**
 * Shared pressed-state toggle control styled with form tokens.
 *
 * @param props Radix toggle root props.
 * @returns Toggle root element.
 */
const Toggle = React.forwardRef<
  React.ElementRef<typeof TogglePrimitive.Root>,
  React.ComponentPropsWithoutRef<typeof TogglePrimitive.Root>
>(({ className, ...props }, ref) => (
  <TogglePrimitive.Root
    ref={ref}
    className={classNames(formStyles.toggle, className)}
    {...props}
  />
));
Toggle.displayName = TogglePrimitive.Root.displayName;

export { Toggle };
