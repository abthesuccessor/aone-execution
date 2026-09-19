const DEFAULTS = Object.freeze({
  revision: 0,
  harness: { compression: 'lite' },
  context: { compactionEnabled: true, maxCharacters: 48000 },
  memory: { enabled: true },
  skills: { disabledIds: [] },
});
export const defaultEngineeringSettings = () => structuredClone(DEFAULTS);
const invalid = (message) => Object.assign(new Error(message), { code: 'ENGINEERING_SETTINGS_INVALID', status: 422 });

export function validateEngineeringSettings(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw invalid('Settings must be an object.');
  if (!['off', 'lite', 'full', 'ultra'].includes(value.harness?.compression)) throw invalid('Choose off, lite, full or ultra compression.');
  if (typeof value.context?.compactionEnabled !== 'boolean' || !Number.isInteger(value.context.maxCharacters) || value.context.maxCharacters < 4000 || value.context.maxCharacters > 200000) throw invalid('Context requires compactionEnabled and a 4,000–200,000 character budget.');
  if (typeof value.memory?.enabled !== 'boolean') throw invalid('Memory enabled must be a boolean.');
  const disabled = value.skills?.disabledIds;
  if (!Array.isArray(disabled) || disabled.length > 5000 || disabled.some((id) => typeof id !== 'string' || !id.trim() || id.length > 300)) throw invalid('Disabled skills must contain at most 5,000 valid skill IDs.');
  return { harness: { compression: value.harness.compression }, context: { compactionEnabled: value.context.compactionEnabled, maxCharacters: value.context.maxCharacters }, memory: { enabled: value.memory.enabled }, skills: { disabledIds: [...new Set(disabled)].sort() } };
}

export class EngineeringSettingsStore {
  constructor(repository) {
    this.repository = repository;
    this.database = repository.database;
    this.database.exec(`CREATE TABLE IF NOT EXISTS engineering_settings (
      id TEXT PRIMARY KEY, revision INTEGER NOT NULL, settings_json TEXT NOT NULL, updated_at TEXT NOT NULL
    );`);
    const { revision, ...settings } = defaultEngineeringSettings();
    this.database.prepare('INSERT INTO engineering_settings (id,revision,settings_json,updated_at) VALUES (?,?,?,?) ON CONFLICT(id) DO NOTHING').run('global', revision, JSON.stringify(settings), new Date().toISOString());
  }
  get() {
    const row = this.database.prepare('SELECT revision,settings_json FROM engineering_settings WHERE id=?').get('global');
    return { revision: row.revision, ...JSON.parse(row.settings_json) };
  }
  update(input) {
    const settings = validateEngineeringSettings(input);
    if (!Number.isInteger(input.expectedRevision) || input.expectedRevision < 0) throw invalid('expectedRevision is required. Reload settings before saving.');
    return this.repository.transaction(() => {
      const changed = this.database.prepare('UPDATE engineering_settings SET revision=revision+1,settings_json=?,updated_at=? WHERE id=? AND revision=?').run(JSON.stringify(settings), new Date().toISOString(), 'global', input.expectedRevision);
      if (changed.changes !== 1) throw Object.assign(new Error('Settings changed in another window. Reload and review before saving.'), { status: 409, code: 'ENGINEERING_SETTINGS_STALE' });
      return this.get();
    });
  }
}

export function createEngineeringSettingsRoutes({ repository, readJson, json, HttpError }) {
  const settingsStore = new EngineeringSettingsStore(repository);
  return { settingsStore, async handle({ request, response, path, method, cors }) {
    if (path !== '/api/engineering/settings') return false;
    try {
      if (method === 'GET') json(response, 200, settingsStore.get(), cors);
      else if (method === 'PUT') json(response, 200, settingsStore.update(await readJson(request)), cors);
      else throw new HttpError(405, 'METHOD_NOT_ALLOWED', 'Use GET or PUT for engineering settings.');
      return true;
    } catch (error) {
      if (error.status && error.code) throw new HttpError(error.status, error.code, error.message);
      throw error;
    }
  } };
}
