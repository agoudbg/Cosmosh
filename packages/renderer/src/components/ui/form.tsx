import classNames from 'classnames';
import React from 'react';

import { formStyles } from './form-styles';

const Form = React.forwardRef<HTMLFormElement, React.ComponentPropsWithoutRef<'form'>>(
  ({ className, ...props }, ref) => (
    <form
      ref={ref}
      className={classNames(formStyles.root, className)}
      {...props}
    />
  ),
);
Form.displayName = 'Form';

const FormField = React.forwardRef<HTMLDivElement, React.ComponentPropsWithoutRef<'div'>>(
  ({ className, ...props }, ref) => (
    <div
      ref={ref}
      className={classNames(formStyles.field, className)}
      {...props}
    />
  ),
);
FormField.displayName = 'FormField';

/**
 * Renders the shared second-level heading for grouped form content.
 *
 * @param props Native heading props plus optional style overrides.
 * @param ref Forwarded heading element reference.
 * @returns A consistently styled semantic form section heading.
 */
const FormSectionHeading = React.forwardRef<HTMLHeadingElement, React.ComponentPropsWithoutRef<'h2'>>(
  ({ className, ...props }, ref) => (
    <h2
      ref={ref}
      className={classNames(formStyles.sectionHeading, className)}
      {...props}
    />
  ),
);
FormSectionHeading.displayName = 'FormSectionHeading';

const FormLabel = React.forwardRef<HTMLLabelElement, React.ComponentPropsWithoutRef<'label'>>(
  ({ className, ...props }, ref) => (
    <label
      ref={ref}
      className={classNames(formStyles.label, className)}
      {...props}
    />
  ),
);
FormLabel.displayName = 'FormLabel';

const FormControl = React.forwardRef<HTMLDivElement, React.ComponentPropsWithoutRef<'div'>>((props, ref) => (
  <div
    ref={ref}
    {...props}
  />
));
FormControl.displayName = 'FormControl';

const FormMessage = React.forwardRef<HTMLSpanElement, React.ComponentPropsWithoutRef<'span'>>(
  ({ className, ...props }, ref) => (
    <span
      ref={ref}
      className={classNames(formStyles.message, className)}
      {...props}
    />
  ),
);
FormMessage.displayName = 'FormMessage';

const FormSubmit = React.forwardRef<HTMLButtonElement, React.ComponentPropsWithoutRef<'button'>>(
  ({ className, type = 'submit', ...props }, ref) => (
    <button
      ref={ref}
      type={type}
      className={className}
      {...props}
    />
  ),
);
FormSubmit.displayName = 'FormSubmit';

export { Form, FormControl, FormField, FormLabel, FormMessage, FormSectionHeading, FormSubmit };
