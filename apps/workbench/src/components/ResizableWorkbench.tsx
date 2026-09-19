import {
  Children,
  type CSSProperties,
  type KeyboardEvent as ReactKeyboardEvent,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
} from 'react';
import { IconGripHorizontal, IconGripVertical } from '@tabler/icons-react';

export const WORKBENCH_LAYOUT_STORAGE_KEY = 'ege.workbench.layout.v1';
const WORKBENCH_LAYOUT_STORAGE_VERSION = 1;

const DEFAULT_LAYOUT = { left: 190, right: 318, bottom: 310 } as const;
const MINIMUM = { left: 150, right: 280, bottom: 220 } as const;
const MAXIMUM = { left: 420, right: 520, bottom: 520 } as const;
const MINIMUM_CANVAS_WIDTH = 400;
const MINIMUM_UPPER_HEIGHT = 220;
const RESIZE_HANDLE_SIZE = 8;
const STACK_BREAKPOINT = 980;
const KEYBOARD_STEP = 8;
const KEYBOARD_LARGE_STEP = 32;

type ResizeAxis = keyof typeof DEFAULT_LAYOUT;
type LayoutSizes = Record<ResizeAxis, number>;

interface ContainerSize {
  width: number;
  height: number;
}

interface DragState {
  axis: ResizeAxis;
  startCoordinate: number;
  startValue: number;
  pointerId: number;
  handle: HTMLDivElement;
}

interface StoredLayout {
  version: typeof WORKBENCH_LAYOUT_STORAGE_VERSION;
  sizes: LayoutSizes;
}

interface ResizableWorkbenchProps {
  children: ReactNode;
  hiddenPanels?: { left?: boolean; right?: boolean; bottom?: boolean };
  resetKey?: number;
}

export function ResizableWorkbench({ children, hiddenPanels = {}, resetKey = 0 }: ResizableWorkbenchProps) {
  const regions = Children.toArray(children);
  const [leftRegion, centerRegion, rightRegion, bottomRegion] = regions;
  const layoutId = useId();
  const regionIds = {
    left: `${layoutId}-library`,
    center: `${layoutId}-canvas`,
    right: `${layoutId}-inspector`,
    bottom: `${layoutId}-bottom`,
  };
  const rootRef = useRef<HTMLElement>(null);
  const [layout, setLayout] = useState<LayoutSizes>(readStoredLayout);
  const liveLayoutRef = useRef<LayoutSizes>(layout);
  const [containerSize, setContainerSize] = useState<ContainerSize>({ width: 0, height: 0 });
  const [drag, setDrag] = useState<DragState>();
  useEffect(() => { if (resetKey) setLayout({ ...DEFAULT_LAYOUT }); }, [resetKey]);

  useLayoutEffect(() => {
    writeLayoutVariables(rootRef.current, layout);
    liveLayoutRef.current = layout;
  }, [layout]);

  useLayoutEffect(() => {
    const root = rootRef.current;
    if (!root) return;
    const measure = () => {
      const rect = root.getBoundingClientRect();
      setContainerSize((current) => current.width === rect.width && current.height === rect.height
        ? current
        : { width: rect.width, height: rect.height });
    };
    measure();
    if (typeof ResizeObserver === 'undefined') {
      window.addEventListener('resize', measure);
      return () => window.removeEventListener('resize', measure);
    }
    const observer = new ResizeObserver(measure);
    observer.observe(root);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    try {
      const storedLayout: StoredLayout = { version: WORKBENCH_LAYOUT_STORAGE_VERSION, sizes: layout };
      window.localStorage.setItem(WORKBENCH_LAYOUT_STORAGE_KEY, JSON.stringify(storedLayout));
    } catch {
      // Storage can be unavailable in hardened or private browser contexts.
    }
  }, [layout]);

  useEffect(() => {
    if (containerSize.width <= 0 || containerSize.height <= 0 || containerSize.width < STACK_BREAKPOINT) return;
    setLayout((current) => clampLayout(current, containerSize));
  }, [containerSize]);

  useEffect(() => {
    if (!drag) return;
    const previousUserSelect = document.body.style.userSelect;
    const previousCursor = document.body.style.cursor;
    document.body.style.userSelect = 'none';
    document.body.style.cursor = drag.axis === 'bottom' ? 'row-resize' : 'col-resize';

    const isActivePointer = (event: PointerEvent) => event.pointerId === undefined || event.pointerId === drag.pointerId;
    const handlePointerMove = (event: PointerEvent) => {
      if (!isActivePointer(event)) return;
      const coordinate = drag.axis === 'bottom' ? event.clientY : event.clientX;
      const direction = drag.axis === 'left' ? 1 : -1;
      const rawValue = drag.startValue + (coordinate - drag.startCoordinate) * direction;
      const size = measuredSize(rootRef.current, containerSize);
      const bounds = boundsFor(drag.axis, liveLayoutRef.current, size);
      const nextValue = Math.round(clamp(rawValue, bounds.minimum, bounds.maximum));
      liveLayoutRef.current = { ...liveLayoutRef.current, [drag.axis]: nextValue };
      writeAxisVariable(rootRef.current, drag.axis, nextValue);
    };
    const finishDrag = (event: PointerEvent) => {
      if (!isActivePointer(event)) return;
      try {
        if (drag.handle.hasPointerCapture?.(drag.pointerId)) drag.handle.releasePointerCapture(drag.pointerId);
      } catch {
        // A browser can release capture before pointercancel reaches this listener.
      }
      setLayout({ ...liveLayoutRef.current });
      setDrag(undefined);
    };

    window.addEventListener('pointermove', handlePointerMove);
    window.addEventListener('pointerup', finishDrag);
    window.addEventListener('pointercancel', finishDrag);
    return () => {
      window.removeEventListener('pointermove', handlePointerMove);
      window.removeEventListener('pointerup', finishDrag);
      window.removeEventListener('pointercancel', finishDrag);
      try {
        if (drag.handle.hasPointerCapture?.(drag.pointerId)) drag.handle.releasePointerCapture(drag.pointerId);
      } catch {
        // Capture can already be gone during unmount or pointer cancellation.
      }
      document.body.style.userSelect = previousUserSelect;
      document.body.style.cursor = previousCursor;
    };
  }, [drag, containerSize]);

  const beginDrag = (axis: ResizeAxis, event: ReactPointerEvent<HTMLDivElement>) => {
    event.preventDefault();
    try {
      event.currentTarget.setPointerCapture?.(event.pointerId);
    } catch {
      // Window listeners below retain drag behavior when pointer capture is unavailable.
    }
    liveLayoutRef.current = layout;
    setDrag({
      axis,
      startCoordinate: axis === 'bottom' ? event.clientY : event.clientX,
      startValue: layout[axis],
      pointerId: event.pointerId,
      handle: event.currentTarget,
    });
  };

  const handleKeyboardResize = (axis: ResizeAxis, event: ReactKeyboardEvent<HTMLDivElement>) => {
    const size = measuredSize(rootRef.current, containerSize);
    const bounds = boundsFor(axis, layout, size);
    let nextValue: number | undefined;
    const step = event.shiftKey ? KEYBOARD_LARGE_STEP : KEYBOARD_STEP;

    if (event.key === 'Home') nextValue = bounds.minimum;
    if (event.key === 'End') nextValue = bounds.maximum;
    if (axis === 'left' && event.key === 'ArrowLeft') nextValue = layout.left - step;
    if (axis === 'left' && event.key === 'ArrowRight') nextValue = layout.left + step;
    if (axis === 'right' && event.key === 'ArrowLeft') nextValue = layout.right + step;
    if (axis === 'right' && event.key === 'ArrowRight') nextValue = layout.right - step;
    if (axis === 'bottom' && event.key === 'ArrowUp') nextValue = layout.bottom + step;
    if (axis === 'bottom' && event.key === 'ArrowDown') nextValue = layout.bottom - step;

    if (nextValue === undefined) return;
    event.preventDefault();
    setLayout((current) => ({
      ...current,
      [axis]: clamp(nextValue, bounds.minimum, bounds.maximum),
    }));
  };

  const rootStyle = {
    '--left-panel-width': `${layout.left}px`,
    '--right-panel-width': `${layout.right}px`,
    '--bottom-panel-height': `${layout.bottom}px`,
  } as CSSProperties;

  return (
    <main
      ref={rootRef}
      className={`workbench-main${hiddenPanels.left ? ' hide-left' : ''}${hiddenPanels.right ? ' hide-right' : ''}${hiddenPanels.bottom ? ' hide-bottom' : ''}${drag ? ` is-resizing is-resizing-${drag.axis}` : ''}`}
      style={rootStyle}
    >
      <div id={regionIds.left} className="workbench-region workbench-region-library">{leftRegion}</div>
      {!hiddenPanels.left && <ResizeHandle axis="left" controls={`${regionIds.left} ${regionIds.center}`} layout={layout} containerSize={containerSize} onPointerDown={beginDrag} onKeyDown={handleKeyboardResize} />}
      <div id={regionIds.center} className="workbench-region workbench-region-canvas">{centerRegion}</div>
      {!hiddenPanels.right && <ResizeHandle axis="right" controls={`${regionIds.center} ${regionIds.right}`} layout={layout} containerSize={containerSize} onPointerDown={beginDrag} onKeyDown={handleKeyboardResize} />}
      <div id={regionIds.right} className="workbench-region workbench-region-inspector">{rightRegion}</div>
      {!hiddenPanels.bottom && <ResizeHandle axis="bottom" controls={`${regionIds.left} ${regionIds.center} ${regionIds.right} ${regionIds.bottom}`} layout={layout} containerSize={containerSize} onPointerDown={beginDrag} onKeyDown={handleKeyboardResize} />}
      <div id={regionIds.bottom} className="workbench-region workbench-region-bottom">{bottomRegion}</div>
    </main>
  );
}

function ResizeHandle({ axis, controls, layout, containerSize, onPointerDown, onKeyDown }: {
  axis: ResizeAxis;
  controls: string;
  layout: LayoutSizes;
  containerSize: ContainerSize;
  onPointerDown: (axis: ResizeAxis, event: ReactPointerEvent<HTMLDivElement>) => void;
  onKeyDown: (axis: ResizeAxis, event: ReactKeyboardEvent<HTMLDivElement>) => void;
}) {
  const bounds = boundsFor(axis, layout, containerSize);
  const orientation = axis === 'bottom' ? 'horizontal' : 'vertical';
  const label = axis === 'left'
    ? 'Resize node library'
    : axis === 'right'
      ? 'Resize node context'
      : 'Resize plan, execution, and trace panel';
  const GripIcon = axis === 'bottom' ? IconGripHorizontal : IconGripVertical;
  return (
    <div
      role="separator"
      tabIndex={0}
      className={`resize-handle resize-handle-${axis}`}
      data-resize-axis={axis}
      aria-label={label}
      aria-controls={controls}
      aria-orientation={orientation}
      aria-valuemin={Math.round(bounds.minimum)}
      aria-valuemax={Math.round(bounds.maximum)}
      aria-valuenow={Math.round(layout[axis])}
      aria-valuetext={`${Math.round(layout[axis])} pixels`}
      title={`${label}. Use arrow keys, Home, or End.`}
      onPointerDown={(event) => onPointerDown(axis, event)}
      onKeyDown={(event) => onKeyDown(axis, event)}
    >
      <GripIcon size={13} stroke={1.8} aria-hidden="true" />
    </div>
  );
}

function readStoredLayout(): LayoutSizes {
  if (typeof window === 'undefined') return { ...DEFAULT_LAYOUT };
  try {
    const stored = JSON.parse(window.localStorage.getItem(WORKBENCH_LAYOUT_STORAGE_KEY) ?? '{}') as Partial<StoredLayout>;
    if (stored.version !== WORKBENCH_LAYOUT_STORAGE_VERSION || !stored.sizes) return { ...DEFAULT_LAYOUT };
    const value = stored.sizes;
    return {
      left: validStoredValue(value.left, DEFAULT_LAYOUT.left, MINIMUM.left, MAXIMUM.left),
      right: validStoredValue(value.right, DEFAULT_LAYOUT.right, MINIMUM.right, MAXIMUM.right),
      bottom: validStoredValue(value.bottom, DEFAULT_LAYOUT.bottom, MINIMUM.bottom, MAXIMUM.bottom),
    };
  } catch {
    return { ...DEFAULT_LAYOUT };
  }
}

function validStoredValue(value: unknown, fallback: number, minimum: number, maximum: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? clamp(value, minimum, maximum) : fallback;
}

function clampLayout(layout: LayoutSizes, size: ContainerSize): LayoutSizes {
  const leftBounds = boundsFor('left', layout, size);
  const left = clamp(layout.left, leftBounds.minimum, leftBounds.maximum);
  const withLeft = { ...layout, left };
  const rightBounds = boundsFor('right', withLeft, size);
  const right = clamp(layout.right, rightBounds.minimum, rightBounds.maximum);
  const withColumns = { ...withLeft, right };
  const finalLeftBounds = boundsFor('left', withColumns, size);
  const bottomBounds = boundsFor('bottom', withColumns, size);
  return {
    left: clamp(left, finalLeftBounds.minimum, finalLeftBounds.maximum),
    right,
    bottom: clamp(layout.bottom, bottomBounds.minimum, bottomBounds.maximum),
  };
}

function boundsFor(axis: ResizeAxis, layout: LayoutSizes, size: ContainerSize): { minimum: number; maximum: number } {
  if (axis === 'bottom') {
    const dynamicMaximum = size.height > 0
      ? size.height - MINIMUM_UPPER_HEIGHT - RESIZE_HANDLE_SIZE
      : MAXIMUM.bottom;
    return { minimum: MINIMUM.bottom, maximum: Math.max(MINIMUM.bottom, Math.min(MAXIMUM.bottom, dynamicMaximum)) };
  }

  if (size.width <= 0 || size.width <= STACK_BREAKPOINT) {
    return { minimum: MINIMUM[axis], maximum: MAXIMUM[axis] };
  }
  const otherWidth = axis === 'left' ? layout.right : layout.left;
  const dynamicMaximum = size.width - otherWidth - MINIMUM_CANVAS_WIDTH - RESIZE_HANDLE_SIZE * 2;
  return { minimum: MINIMUM[axis], maximum: Math.max(MINIMUM[axis], Math.min(MAXIMUM[axis], dynamicMaximum)) };
}

function measuredSize(root: HTMLElement | null, fallback: ContainerSize): ContainerSize {
  const rect = root?.getBoundingClientRect();
  return {
    width: rect?.width || fallback.width,
    height: rect?.height || fallback.height,
  };
}

function writeLayoutVariables(root: HTMLElement | null, layout: LayoutSizes) {
  writeAxisVariable(root, 'left', layout.left);
  writeAxisVariable(root, 'right', layout.right);
  writeAxisVariable(root, 'bottom', layout.bottom);
}

function writeAxisVariable(root: HTMLElement | null, axis: ResizeAxis, value: number) {
  const property = axis === 'left'
    ? '--left-panel-width'
    : axis === 'right'
      ? '--right-panel-width'
      : '--bottom-panel-height';
  root?.style.setProperty(property, `${Math.round(value)}px`);
}

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.min(maximum, Math.max(minimum, value));
}
