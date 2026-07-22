import classNames from 'classnames';
import React from 'react';

/** Shared geometry and reduced-motion behavior for every shimmer block. */
const SKELETON_SHIMMER_CLASS_NAME =
  'relative overflow-hidden before:absolute before:inset-0 before:-translate-x-full before:animate-skeleton-shimmer before:bg-gradient-to-r before:from-transparent before:to-transparent motion-reduce:before:hidden';

/** Theme-aware shimmer colors for standard application surfaces. */
const SKELETON_TONE_CLASS_NAME = 'bg-skeleton before:via-skeleton-shimmer';

/** Higher-contrast shimmer colors for the dark SFTP terminal surface. */
const SKELETON_SURFACE_TONE_CLASS_NAME = 'bg-skeleton-surface before:via-skeleton-surface-shimmer';

type SkeletonProps = {
  className?: string;
  style?: React.CSSProperties;
};

/**
 * Base skeleton placeholder block.
 *
 * Renders a rounded placeholder tinted with the Home card palette with a
 * left-to-right shimmer sweep so skeletons stay visually consistent across
 * the Home, SFTP, and SSH pages.
 *
 * @param props Skeleton presentation properties.
 * @param props.className Optional layout and shape classes.
 * @param props.style Optional inline geometry used by data-driven skeletons.
 * @returns A decorative skeleton block hidden from assistive technology.
 */
export const Skeleton: React.FC<SkeletonProps> = ({ className, style }) => {
  return (
    <div
      aria-hidden="true"
      className={classNames('rounded-md', SKELETON_SHIMMER_CLASS_NAME, SKELETON_TONE_CLASS_NAME, className)}
      style={style}
    />
  );
};

/**
 * Skeleton block variant for dark terminal-card surfaces (SFTP/SSH panels).
 *
 * @param props Skeleton presentation properties.
 * @param props.className Optional layout and shape classes.
 * @param props.style Optional inline geometry used by data-driven skeletons.
 * @returns A higher-contrast decorative skeleton block.
 */
export const SurfaceSkeleton: React.FC<SkeletonProps> = ({ className, style }) => {
  return (
    <div
      aria-hidden="true"
      className={classNames('rounded-md', SKELETON_SHIMMER_CLASS_NAME, SKELETON_SURFACE_TONE_CLASS_NAME, className)}
      style={style}
    />
  );
};

/**
 * Visually hides the label announced for a skeleton region.
 *
 * @param props Accessible label properties.
 * @param props.label Localized loading label.
 * @returns A screen-reader-only label.
 */
const SkeletonA11yLabel: React.FC<{ label: string }> = ({ label }) => <span className="sr-only">{label}</span>;

/**
 * Skeleton matching a single Home `EntityCard` row (icon + title/subtitle lines).
 *
 * @returns A decorative Home entity-card placeholder.
 */
const SkeletonEntityCard: React.FC = () => {
  return (
    <div className="inline-flex min-h-[46px] w-full items-center gap-2.5 rounded-lg-2 px-2 py-2">
      <Skeleton className="h-[30px] w-[30px] shrink-0 rounded-lg-2" />
      <div className="flex min-w-0 flex-1 flex-col gap-1.5">
        <Skeleton className="h-3.5 w-3/5" />
        <Skeleton className="h-2.5 w-2/5" />
      </div>
    </div>
  );
};

/**
 * Skeleton matching a Home sidebar section (section label + card rows).
 *
 * @param props Sidebar section properties.
 * @param props.rows Number of entity rows to render.
 * @returns A decorative Home sidebar-section placeholder.
 */
const SkeletonSidebarSection: React.FC<{ rows: number }> = ({ rows }) => {
  return (
    <div className="pb-5">
      <Skeleton className="mx-2 mb-2.5 h-3 w-20" />
      <div className="space-y-1.5">
        {Array.from({ length: rows }, (_, index) => (
          <SkeletonEntityCard key={index} />
        ))}
      </div>
    </div>
  );
};

/**
 * Skeleton matching one Home card-grid section (label + auto-fill card grid).
 *
 * The grid template mirrors the real Home layout (`repeat(auto-fill,250px)`)
 * so the placeholder aligns with the cards that replace it.
 *
 * @param props Grid placeholder properties.
 * @param props.count Number of entity cards to render.
 * @returns A decorative Home card-grid placeholder.
 */
const SkeletonEntityCardGrid: React.FC<{ count: number }> = ({ count }) => {
  return (
    <section>
      <Skeleton className="mx-2 mb-2.5 h-3 w-24" />
      <div className="grid grid-cols-[repeat(auto-fill,250px)] gap-x-7 gap-y-3">
        {Array.from({ length: count }, (_, index) => (
          <SkeletonEntityCard key={index} />
        ))}
      </div>
    </section>
  );
};

/**
 * Skeleton matching one SFTP directory-tree row (folder icon + name).
 * Mirrors the real 30px tree rows: a 20px chevron slot keeps the icon at the
 * same x offset as loaded rows, while the chevron glyph itself is omitted.
 *
 * @returns A decorative SFTP tree-row placeholder.
 */
const SkeletonTreeRow: React.FC = () => {
  return (
    <div className="flex h-[30px] w-full items-center">
      <span className="w-5 shrink-0" />
      <div className="flex h-[30px] min-w-0 flex-1 items-center gap-2 pr-2">
        <SurfaceSkeleton className="h-4 w-3.5 shrink-0 rounded-xs-2" />
        <SurfaceSkeleton className="h-3 w-1/2" />
      </div>
    </div>
  );
};

/**
 * Column layout descriptor for the SFTP directory-list skeleton.
 * Values mirror the live column definition so the placeholder matches the
 * user's current column visibility and widths exactly.
 */
type SkeletonSftpColumn = {
  id: string;
  align: 'left' | 'right';
};

type SkeletonSftpGridProps = {
  columns: SkeletonSftpColumn[];
  columnGap: number;
  gridTemplateColumns: string;
};

/**
 * Header label width (ch) for one SFTP column kind, approximating the real
 * localized column titles without pulling i18n into the shared component.
 */
const SFTP_SKELETON_HEADER_WIDTHS: Record<string, string> = {
  name: '6ch',
  modifiedAt: '14ch',
  type: '5ch',
  size: '5ch',
  accessedAt: '14ch',
  permissions: '10ch',
  permissionOctal: '8ch',
};

/**
 * Body content width for one SFTP column kind, approximating typical values
 * (dates, octal modes, sizes) rendered in each column.
 */
const SFTP_SKELETON_BODY_WIDTHS: Record<string, string> = {
  modifiedAt: '16ch',
  type: '8ch',
  size: '9ch',
  accessedAt: '16ch',
  permissions: '10ch',
  permissionOctal: '4ch',
};

/**
 * Skeleton matching one SFTP directory-list row (34px grid row using the
 * live column layout; name cell keeps the file-icon + label shape).
 *
 * @param props File-row placeholder properties.
 * @param props.columns Visible SFTP column descriptors.
 * @param props.columnGap Gap between directory columns in pixels.
 * @param props.gridTemplateColumns Complete live directory grid template.
 * @returns A decorative SFTP file-row placeholder.
 */
const SkeletonFileRow: React.FC<SkeletonSftpGridProps> = ({ columns, columnGap, gridTemplateColumns }) => {
  return (
    <div
      className="grid h-[34px] w-full items-center rounded-lg px-3"
      style={{ columnGap, gridTemplateColumns }}
    >
      {columns.map((column) =>
        column.id === 'name' ? (
          <span
            key={column.id}
            className="flex min-w-0 items-center gap-2"
          >
            <SurfaceSkeleton className="h-[18px] w-4 shrink-0 rounded-xs-2" />
            <SurfaceSkeleton className="h-3 w-3/5 max-w-40" />
          </span>
        ) : (
          <SurfaceSkeleton
            key={column.id}
            className={classNames('h-3', column.align === 'right' && 'justify-self-end')}
            style={{ width: SFTP_SKELETON_BODY_WIDTHS[column.id] ?? '8ch' }}
          />
        ),
      )}
    </div>
  );
};

/**
 * Full Home page body skeleton (card-grid sections) announced as busy.
 *
 * @param props Home body loading properties.
 * @param props.label Localized loading status label.
 * @returns An accessible Home body loading region.
 */
export const HomeBodySkeleton: React.FC<{ label: string }> = ({ label }) => {
  return (
    <div
      role="status"
      aria-busy="true"
    >
      <SkeletonA11yLabel label={label} />
      <div className="space-y-4 pb-2">
        <SkeletonEntityCardGrid count={6} />
        <SkeletonEntityCardGrid count={6} />
      </div>
    </div>
  );
};

/**
 * Full Home sidebar skeleton (folder/quick-filter sections).
 *
 * @returns A decorative Home sidebar loading placeholder.
 */
export const HomeSidebarSkeleton: React.FC = () => {
  return (
    <div aria-hidden="true">
      <SkeletonSidebarSection rows={1} />
      <SkeletonSidebarSection rows={2} />
      <SkeletonSidebarSection rows={3} />
    </div>
  );
};

/**
 * SFTP directory-tree skeleton rows laid out exactly like the loaded tree:
 * consecutive 30px rows from the panel top (no redistribution).
 *
 * @returns Decorative SFTP directory-tree placeholders.
 */
export const SftpTreeSkeleton: React.FC = () => {
  return (
    <div aria-hidden="true">
      {Array.from({ length: 12 }, (_, index) => (
        <SkeletonTreeRow key={index} />
      ))}
    </div>
  );
};

/**
 * SFTP directory-list skeleton with a header strip matching the real column
 * header (30px) followed by contiguous 34px rows. Column count, widths, gap,
 * and the panel min-width all come from the live directory view settings.
 *
 * @param props Directory-list placeholder properties.
 * @param props.columns Visible SFTP column descriptors.
 * @param props.columnGap Gap between directory columns in pixels.
 * @param props.gridTemplateColumns Complete live directory grid template, including the action spacer.
 * @param props.minWidth Minimum width of the directory grid in pixels.
 * @returns Decorative SFTP directory-list placeholders.
 */
export const SftpFileListSkeleton: React.FC<
  SkeletonSftpGridProps & {
    minWidth: number;
  }
> = ({ columns, columnGap, gridTemplateColumns, minWidth }) => {
  return (
    <div
      aria-hidden="true"
      style={{ minWidth }}
    >
      <div
        className="grid h-[30px] shrink-0 items-center px-3"
        style={{ columnGap, gridTemplateColumns }}
      >
        {columns.map((column) => (
          <SurfaceSkeleton
            key={column.id}
            className={classNames('h-2.5', column.align === 'right' && 'justify-self-end')}
            style={{ width: SFTP_SKELETON_HEADER_WIDTHS[column.id] ?? '8ch' }}
          />
        ))}
      </div>
      <div>
        {Array.from({ length: 12 }, (_, index) => (
          <SkeletonFileRow
            key={index}
            columnGap={columnGap}
            columns={columns}
            gridTemplateColumns={gridTemplateColumns}
          />
        ))}
      </div>
    </div>
  );
};
