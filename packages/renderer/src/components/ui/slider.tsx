import * as SliderPrimitive from '@radix-ui/react-slider';
import classNames from 'classnames';
import React from 'react';

import { formStyles } from './form-styles';

const Slider = React.forwardRef<
  React.ElementRef<typeof SliderPrimitive.Root>,
  React.ComponentPropsWithoutRef<typeof SliderPrimitive.Root>
>(({ className, ...props }, ref) => (
  <SliderPrimitive.Root
    ref={ref}
    className={classNames(formStyles.sliderRoot, className)}
    {...props}
  >
    <SliderPrimitive.Track className={formStyles.sliderTrack}>
      <SliderPrimitive.Range className={formStyles.sliderRange} />
    </SliderPrimitive.Track>
    <SliderPrimitive.Thumb className={formStyles.sliderThumb} />
  </SliderPrimitive.Root>
));
Slider.displayName = SliderPrimitive.Root.displayName;

export { Slider };
