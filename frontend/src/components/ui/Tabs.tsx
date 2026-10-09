import { type ReactNode } from 'react';
import * as TabsPrimitive from '@radix-ui/react-tabs';

export interface TabsProps {
  value: string;
  onValueChange: (value: string) => void;
  items: Array<{ value: string; label: ReactNode; content: ReactNode }>;
  'aria-label'?: string;
}

export function Tabs({ value, onValueChange, items, 'aria-label': label = 'View' }: TabsProps) {
  return (
    <TabsPrimitive.Root className="ui-tabs" value={value} onValueChange={onValueChange}>
      <TabsPrimitive.List className="ui-tabs-list" aria-label={label}>
        {items.map((item) => (
          <TabsPrimitive.Trigger className="ui-tabs-trigger" key={item.value} value={item.value}>
            {item.label}
          </TabsPrimitive.Trigger>
        ))}
      </TabsPrimitive.List>
      {items.map((item) => (
        <TabsPrimitive.Content className="ui-tabs-content" key={item.value} value={item.value}>
          {item.content}
        </TabsPrimitive.Content>
      ))}
    </TabsPrimitive.Root>
  );
}
