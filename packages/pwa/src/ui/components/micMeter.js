// Voice level meter + listening indicator. Pure; reads {level, listening,
// speaking, processing} and reflects them visually.
import { dd } from '../../runtime.js';

const { alias, div } = dd;

export default alias((props) => {
  const { level = 0, listening, speaking, processing } = props;
  const pct = Math.min(100, Math.round(level * 600));
  const cls = ['meter', listening && 'listening', speaking && 'speaking', processing && 'processing']
    .filter(Boolean)
    .join(' ');
  return div({ className: cls },
    div({ className: 'meter-fill', $styling: { width: `${pct}%` } }),
  );
});
