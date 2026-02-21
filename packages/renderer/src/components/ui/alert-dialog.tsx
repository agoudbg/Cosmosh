import * as AlertDialogPrimitive from '@radix-ui/react-alert-dialog';
import classNames from 'classnames';
import React from 'react';

import { dialogStyles } from './dialog-styles';
import { formStyles } from './form-styles';

const AlertDialog = AlertDialogPrimitive.Root;
const AlertDialogTrigger = AlertDialogPrimitive.Trigger;
const AlertDialogPortal = AlertDialogPrimitive.Portal;
const AlertDialogCancel = AlertDialogPrimitive.Cancel;
const AlertDialogAction = AlertDialogPrimitive.Action;

const AlertDialogOverlay = React.forwardRef<
  React.ElementRef<typeof AlertDialogPrimitive.Overlay>,
  React.ComponentPropsWithoutRef<typeof AlertDialogPrimitive.Overlay>
>(({ className, ...props }, ref) => (
  <AlertDialogPrimitive.Overlay
    ref={ref}
    className={classNames(dialogStyles.overlay, className)}
    {...props}
  />
));
AlertDialogOverlay.displayName = AlertDialogPrimitive.Overlay.displayName;

const AlertDialogContent = React.forwardRef<
  React.ElementRef<typeof AlertDialogPrimitive.Content>,
  React.ComponentPropsWithoutRef<typeof AlertDialogPrimitive.Content>
>(({ className, ...props }, ref) => (
  <AlertDialogPortal>
    <AlertDialogOverlay />
    <AlertDialogPrimitive.Content
      ref={ref}
      className={classNames(dialogStyles.content, className)}
      {...props}
    />
  </AlertDialogPortal>
));
AlertDialogContent.displayName = AlertDialogPrimitive.Content.displayName;

const AlertDialogHeader: React.FC<React.HTMLAttributes<HTMLDivElement>> = ({ className, ...props }) => (
  <div
    className={classNames(dialogStyles.header, className)}
    {...props}
  />
);
AlertDialogHeader.displayName = 'AlertDialogHeader';

const AlertDialogFooter: React.FC<React.HTMLAttributes<HTMLDivElement>> = ({ className, ...props }) => (
  <div
    className={classNames(dialogStyles.footer, className)}
    {...props}
  />
);
AlertDialogFooter.displayName = 'AlertDialogFooter';

const AlertDialogTitle = React.forwardRef<
  React.ElementRef<typeof AlertDialogPrimitive.Title>,
  React.ComponentPropsWithoutRef<typeof AlertDialogPrimitive.Title>
>(({ className, ...props }, ref) => (
  <AlertDialogPrimitive.Title
    ref={ref}
    className={classNames(dialogStyles.title, className)}
    {...props}
  />
));
AlertDialogTitle.displayName = AlertDialogPrimitive.Title.displayName;

const AlertDialogDescription = React.forwardRef<
  React.ElementRef<typeof AlertDialogPrimitive.Description>,
  React.ComponentPropsWithoutRef<typeof AlertDialogPrimitive.Description>
>(({ className, ...props }, ref) => (
  <AlertDialogPrimitive.Description
    ref={ref}
    className={classNames(dialogStyles.description, className)}
    {...props}
  />
));
AlertDialogDescription.displayName = AlertDialogPrimitive.Description.displayName;

const AlertDialogCancelButton = React.forwardRef<
  React.ElementRef<typeof AlertDialogPrimitive.Cancel>,
  React.ComponentPropsWithoutRef<typeof AlertDialogPrimitive.Cancel> & {
    padding?: 'default' | 'mid' | 'wide';
  }
>(({ className, padding = 'mid', ...props }, ref) => (
  <AlertDialogPrimitive.Cancel
    ref={ref}
    className={classNames(
      formStyles.buttonGhost,
      padding === 'mid' && 'px-[15px]',
      padding === 'wide' && 'px-[18px]',
      className,
    )}
    {...props}
  />
));
AlertDialogCancelButton.displayName = AlertDialogPrimitive.Cancel.displayName;

const AlertDialogActionButton = React.forwardRef<
  React.ElementRef<typeof AlertDialogPrimitive.Action>,
  React.ComponentPropsWithoutRef<typeof AlertDialogPrimitive.Action> & {
    tone?: 'default' | 'inverted';
    padding?: 'default' | 'wide';
  }
>(({ className, tone = 'inverted', padding = 'wide', ...props }, ref) => (
  <AlertDialogPrimitive.Action
    ref={ref}
    className={classNames(
      tone === 'inverted' ? formStyles.buttonInverted : formStyles.button,
      padding === 'wide' && 'px-[18px]',
      className,
    )}
    {...props}
  />
));
AlertDialogActionButton.displayName = AlertDialogPrimitive.Action.displayName;

export {
  AlertDialog,
  AlertDialogTrigger,
  AlertDialogPortal,
  AlertDialogOverlay,
  AlertDialogContent,
  AlertDialogHeader,
  AlertDialogFooter,
  AlertDialogTitle,
  AlertDialogDescription,
  AlertDialogCancel,
  AlertDialogAction,
  AlertDialogCancelButton,
  AlertDialogActionButton,
};
