import * as DialogPrimitive from '@radix-ui/react-dialog';
import classNames from 'classnames';
import { X } from 'lucide-react';
import React from 'react';

import { Button } from './button';
import { dialogStyles } from './dialog-styles';

const Dialog = DialogPrimitive.Root;
const DialogTrigger = DialogPrimitive.Trigger;
const DialogPortal = DialogPrimitive.Portal;
const DialogClose = DialogPrimitive.Close;

const DialogOverlay = React.forwardRef<
  React.ElementRef<typeof DialogPrimitive.Overlay>,
  React.ComponentPropsWithoutRef<typeof DialogPrimitive.Overlay>
>(({ className, ...props }, ref) => (
  <DialogPrimitive.Overlay
    ref={ref}
    className={classNames(dialogStyles.overlay, className)}
    {...props}
  />
));
DialogOverlay.displayName = DialogPrimitive.Overlay.displayName;

type DialogContentProps = React.ComponentPropsWithoutRef<typeof DialogPrimitive.Content> & {
  showCloseButton?: boolean;
};

const DialogContent = React.forwardRef<React.ElementRef<typeof DialogPrimitive.Content>, DialogContentProps>(
  ({ className, children, showCloseButton = true, ...props }, ref) => (
    <DialogPortal>
      <DialogOverlay />
      <DialogPrimitive.Content
        ref={ref}
        className={classNames(dialogStyles.content, className)}
        {...props}
      >
        {children}
        {showCloseButton ? (
          <DialogPrimitive.Close
            className={dialogStyles.closeButton}
            aria-label="Close"
          >
            <X className="h-4 w-4" />
          </DialogPrimitive.Close>
        ) : null}
      </DialogPrimitive.Content>
    </DialogPortal>
  ),
);
DialogContent.displayName = DialogPrimitive.Content.displayName;

const DialogHeader: React.FC<React.HTMLAttributes<HTMLDivElement>> = ({ className, ...props }) => (
  <div
    className={classNames(dialogStyles.header, className)}
    {...props}
  />
);
DialogHeader.displayName = 'DialogHeader';

const DialogFooter: React.FC<React.HTMLAttributes<HTMLDivElement>> = ({ className, ...props }) => (
  <div
    className={classNames(
      dialogStyles.footer,
      "[&>button[data-button-variant='ghost']]:px-[15px]",
      "[&>button[data-button-variant='default']]:bg-form-text [&>button[data-button-variant='default']]:text-bg [&>button[data-button-variant='default']]:hover:opacity-90 [&>button[data-button-variant='default']]:px-[18px]",
      "[&>button[data-button-variant='inverted']]:px-[18px]",
      className,
    )}
    {...props}
  />
);
DialogFooter.displayName = 'DialogFooter';

type DialogPrimaryButtonProps = React.ComponentPropsWithoutRef<typeof Button> & {
  tone?: 'default' | 'inverted';
};

const DialogPrimaryButton = React.forwardRef<HTMLButtonElement, DialogPrimaryButtonProps>(
  ({ className, tone = 'inverted', padding = 'wide', ...props }, ref) => (
    <Button
      ref={ref}
      variant={tone === 'inverted' ? 'inverted' : 'default'}
      padding={padding}
      className={className}
      {...props}
    />
  ),
);
DialogPrimaryButton.displayName = 'DialogPrimaryButton';

type DialogSecondaryButtonProps = React.ComponentPropsWithoutRef<typeof Button>;

const DialogSecondaryButton = React.forwardRef<HTMLButtonElement, DialogSecondaryButtonProps>(
  ({ className, variant = 'ghost', padding = 'mid', ...props }, ref) => (
    <Button
      ref={ref}
      variant={variant}
      padding={padding}
      className={className}
      {...props}
    />
  ),
);
DialogSecondaryButton.displayName = 'DialogSecondaryButton';

const DialogTitle = React.forwardRef<
  React.ElementRef<typeof DialogPrimitive.Title>,
  React.ComponentPropsWithoutRef<typeof DialogPrimitive.Title>
>(({ className, ...props }, ref) => (
  <DialogPrimitive.Title
    ref={ref}
    className={classNames(dialogStyles.title, className)}
    {...props}
  />
));
DialogTitle.displayName = DialogPrimitive.Title.displayName;

const DialogDescription = React.forwardRef<
  React.ElementRef<typeof DialogPrimitive.Description>,
  React.ComponentPropsWithoutRef<typeof DialogPrimitive.Description>
>(({ className, ...props }, ref) => (
  <DialogPrimitive.Description
    ref={ref}
    className={classNames(dialogStyles.description, className)}
    {...props}
  />
));
DialogDescription.displayName = DialogPrimitive.Description.displayName;

export {
  Dialog,
  DialogTrigger,
  DialogPortal,
  DialogOverlay,
  DialogContent,
  DialogClose,
  DialogHeader,
  DialogFooter,
  DialogPrimaryButton,
  DialogSecondaryButton,
  DialogTitle,
  DialogDescription,
};
