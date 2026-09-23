import { Box, Text } from 'ink';
import type { Line } from '../lines.js';

export function LineView({ line }: { line: Line }) {
  if (!line.length) return <Text> </Text>;
  return (
    <Text wrap="truncate">
      {line.map((s, i) => (
        <Text key={i} color={s.color} backgroundColor={s.bg} bold={s.bold} italic={s.italic} underline={s.underline}>
          {s.text}
        </Text>
      ))}
    </Text>
  );
}

export function Lines({ lines }: { lines: Line[] }) {
  return (
    <Box flexDirection="column">
      {lines.map((l, i) => (
        <LineView key={i} line={l} />
      ))}
    </Box>
  );
}
