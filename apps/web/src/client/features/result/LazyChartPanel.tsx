import { Suspense, lazy, type ComponentProps } from 'react';

import { ChartSkeleton } from './skeletons/Skeletons';

// Recharts is a large dependency. Code-splitting the chart keeps it out of the
// initial bundle so first paint is fast; the chunk loads when a chart is needed
// (i.e. when the `viz` frame arrives), with a skeleton during the brief fetch.
const ChartPanel = lazy(() => import('./ChartPanel').then((module) => ({ default: module.ChartPanel })));

export function LazyChartPanel(props: ComponentProps<typeof ChartPanel>) {
  return (
    <Suspense fallback={<ChartSkeleton />}>
      <ChartPanel {...props} />
    </Suspense>
  );
}
