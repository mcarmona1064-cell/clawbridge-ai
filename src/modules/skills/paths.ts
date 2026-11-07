/** Where installed skills live on the host (outside the code checkout). */
import path from 'path';

import { DATA_DIR } from '../../config.js';

export function installedSkillsDir(): string {
  return path.join(DATA_DIR, 'skills');
}
