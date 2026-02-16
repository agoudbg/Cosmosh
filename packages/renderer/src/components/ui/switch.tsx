import * as SwitchPrimitive from '@radix-ui/react-switch';
import classNames from 'classnames';
import React from 'react';

import { formStyles } from './form-styles';

const Switch = React.forwardRef<
  React.ElementRef<typeof SwitchPrimitive.Root>,
  React.ComponentPropsWithoutRef<typeof SwitchPrimitive.Root>
>(({ className, ...props }, ref) => (
  <SwitchPrimitive.Root
    ref={ref}
    className={classNames(formStyles.switchRoot, className)}
    {...props}
  >
    <SwitchPrimitive.Thumb className={formStyles.switchThumb} />
  </SwitchPrimitive.Root>
));
Switch.displayName = SwitchPrimitive.Root.displayName;

export { Switch };
