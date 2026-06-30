import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { createRequire } from 'node:module';

// A content signature over every model file's name + source. Used to detect when
// a cached schema has drifted from models/ — including in-place edits to a
// model's columns/comments/associations, which a filename-only check misses.
function signatureFromEntries(entries) {
  const hash = crypto.createHash('sha256');
  for (const [fileName, source] of [...entries].sort((left, right) => left[0].localeCompare(right[0]))) {
    hash.update(fileName);
    hash.update('\0');
    hash.update(source);
    hash.update('\0');
  }
  return hash.digest('hex');
}

async function computeModelsSignature(modelsDir) {
  try {
    const files = (await fs.readdir(modelsDir)).filter((file) => file.endsWith('.js')).sort();
    const entries = [];
    for (const fileName of files) {
      entries.push([fileName, await fs.readFile(path.join(modelsDir, fileName), 'utf8')]);
    }
    return signatureFromEntries(entries);
  } catch {
    // Models directory unreadable; callers should treat the cache as usable.
    return null;
  }
}

function createDataTypesStub() {
  const cache = new Map();

  return new Proxy(
    {},
    {
      get(_target, prop) {
        const key = String(prop);
        if (!cache.has(key)) {
          const fn = (...args) => ({ __dataType: key, args });
          fn.__dataType = key;
          cache.set(key, fn);
        }

        return cache.get(key);
      },
    }
  );
}

function normalizeType(typeValue) {
  if (typeValue == null) {
    return null;
  }

  if (typeof typeValue === 'string') {
    return typeValue;
  }

  if (typeof typeValue === 'function' && typeValue.__dataType) {
    return typeValue.__dataType;
  }

  if (typeof typeValue === 'object' && typeValue.__dataType) {
    const args = Array.isArray(typeValue.args) ? typeValue.args : [];
    if (args.length === 0) {
      return typeValue.__dataType;
    }

    return `${typeValue.__dataType}(${args.map((arg) => JSON.stringify(arg)).join(', ')})`;
  }

  return String(typeValue);
}

function normalizeDefaultValue(value) {
  if (value == null) {
    return null;
  }

  if (typeof value === 'function') {
    return `[Function ${value.name || 'anonymous'}]`;
  }

  if (typeof value === 'object') {
    if (value.__dataType) {
      return normalizeType(value);
    }

    return JSON.stringify(value);
  }

  return value;
}

function extractTableDescription(source, modelName) {
  const pattern = new RegExp(`//\\s*${modelName}:\\s*(.+)`);
  const match = source.match(pattern);
  return match ? match[1].trim() : null;
}

function createModelStub(modelName, attributes, options) {
  return {
    modelName,
    rawAttributes: attributes || {},
    options: options || {},
    prototype: {},
    associationsCaptured: [],
    belongsTo(target, assocOptions = {}) {
      this.associationsCaptured.push({
        type: 'belongsTo',
        target: target?.modelName || null,
        as: assocOptions.as || null,
        foreignKey: assocOptions.foreignKey || null,
        through: null,
      });
      return this;
    },
    hasMany(target, assocOptions = {}) {
      this.associationsCaptured.push({
        type: 'hasMany',
        target: target?.modelName || null,
        as: assocOptions.as || null,
        foreignKey: assocOptions.foreignKey || null,
        through: null,
      });
      return this;
    },
    hasOne(target, assocOptions = {}) {
      this.associationsCaptured.push({
        type: 'hasOne',
        target: target?.modelName || null,
        as: assocOptions.as || null,
        foreignKey: assocOptions.foreignKey || null,
        through: null,
      });
      return this;
    },
    belongsToMany(target, assocOptions = {}) {
      const through =
        typeof assocOptions.through === 'string'
          ? assocOptions.through
          : assocOptions.through?.modelName || null;

      this.associationsCaptured.push({
        type: 'belongsToMany',
        target: target?.modelName || null,
        as: assocOptions.as || null,
        foreignKey: assocOptions.foreignKey || null,
        through,
      });
      return this;
    },
  };
}

function createSequelizeStub(registry) {
  return {
    define(modelName, attributes, options = {}) {
      const model = createModelStub(modelName, attributes, options);
      registry[modelName] = model;
      return model;
    },
  };
}

function normalizeColumn(attrName, rawAttr, modelNames) {
  const rawReference = rawAttr?.references || null;
  const referenceModel = rawReference?.model || null;
  const reference =
    referenceModel && modelNames.has(referenceModel)
      ? {
          model: referenceModel,
          key: rawReference.key || null,
        }
      : null;

  return {
    name: attrName,
    type: normalizeType(rawAttr?.type),
    allowNull: rawAttr?.allowNull ?? null,
    primaryKey: Boolean(rawAttr?.primaryKey),
    autoIncrement: Boolean(rawAttr?.autoIncrement),
    unique: Boolean(rawAttr?.unique),
    defaultValue: normalizeDefaultValue(rawAttr?.defaultValue),
    comment: rawAttr?.comment || null,
    references: reference,
    ignoredReference:
      rawReference && !reference
        ? {
            model: rawReference.model || null,
            key: rawReference.key || null,
          }
        : null,
  };
}

function normalizeAssociations(model, modelNames) {
  return model.associationsCaptured
    .filter((assoc) => assoc.target && modelNames.has(assoc.target))
    .map((assoc) => ({
      type: assoc.type,
      target: assoc.target,
      as: assoc.as,
      foreignKey: assoc.foreignKey,
      through: assoc.through,
    }));
}

export async function compileSchemaFromModelsDir(modelsDir) {
  const require = createRequire(import.meta.url);
  const files = (await fs.readdir(modelsDir)).filter((file) => file.endsWith('.js')).sort();
  const registry = {};
  const sources = new Map();
  const DataTypes = createDataTypesStub();
  const sequelize = createSequelizeStub(registry);

  for (const fileName of files) {
    const absolutePath = path.join(modelsDir, fileName);
    const source = await fs.readFile(absolutePath, 'utf8');
    sources.set(fileName, source);

    const exported = require(absolutePath);
    const factory = exported?.default || exported;
    if (typeof factory !== 'function') {
      throw new Error(`Expected ${absolutePath} to export a model factory function.`);
    }

    factory(sequelize, DataTypes);
  }

  const modelNames = new Set(Object.keys(registry));
  const associationErrors = [];

  for (const model of Object.values(registry)) {
    if (typeof model.associate !== 'function') {
      continue;
    }

    try {
      model.associate(registry);
    } catch (error) {
      associationErrors.push({
        model: model.modelName,
        error: error.message,
      });
    }
  }

  const tables = files.map((fileName) => {
    const modelName = fileName.replace(/\.js$/, '');
    const model = registry[modelName];
    const source = sources.get(fileName) || '';
    const columns = Object.entries(model.rawAttributes).map(([attrName, rawAttr]) =>
      normalizeColumn(attrName, rawAttr, modelNames)
    );

    return {
      name: modelName,
      tableName: model.options.tableName || modelName,
      file: fileName,
      description: extractTableDescription(source, modelName),
      timestamps: Boolean(model.options.timestamps),
      freezeTableName: Boolean(model.options.freezeTableName),
      primaryKey: columns.filter((column) => column.primaryKey).map((column) => column.name),
      columns,
      foreignKeys: columns
        .filter((column) => column.references)
        .map((column) => ({
          column: column.name,
          references: column.references,
        })),
      ignoredForeignKeys: columns
        .filter((column) => column.ignoredReference)
        .map((column) => ({
          column: column.name,
          references: column.ignoredReference,
        })),
      associations: normalizeAssociations(model, modelNames),
    };
  });

  const missingReferencedModels = [
    ...new Set(
      tables.flatMap((table) => table.ignoredForeignKeys.map((foreignKey) => foreignKey.references.model))
    ),
  ].sort();

  return {
    generatedAt: new Date().toISOString(),
    modelsDir,
    sourceSignature: signatureFromEntries([...sources]),
    tableCount: tables.length,
    associationErrors,
    missingReferencedModels,
    tables,
  };
}

export function filterSchema(schema, includedTables) {
  const includeSet = new Set(includedTables);
  const tables = schema.tables
    .filter((table) => includeSet.has(table.name))
    .map((table) => ({
      ...table,
      foreignKeys: table.foreignKeys.filter((fk) => includeSet.has(fk.references.model)),
      associations: table.associations.filter((assoc) => includeSet.has(assoc.target)),
    }));

  return {
    ...schema,
    tableCount: tables.length,
    tables,
  };
}

export async function writeSchemaFile(schema, outputPath) {
  await fs.mkdir(path.dirname(outputPath), { recursive: true });
  await fs.writeFile(outputPath, `${JSON.stringify(schema, null, 2)}\n`, 'utf8');
}

async function listModelFileNames(modelsDir) {
  try {
    const files = await fs.readdir(modelsDir);
    return new Set(files.filter((file) => file.endsWith('.js')));
  } catch {
    // Models directory is unreadable; callers should treat the cache as usable.
    return null;
  }
}

function cachedSchemaFileNames(schema) {
  return new Set(
    (Array.isArray(schema?.tables) ? schema.tables : [])
      .map((table) => table.file)
      .filter(Boolean)
  );
}

function setsAreEqual(left, right) {
  if (left.size !== right.size) {
    return false;
  }
  for (const value of left) {
    if (!right.has(value)) {
      return false;
    }
  }
  return true;
}

/**
 * A cached schema is stale when it was compiled from different model sources than
 * the ones currently on disk: files added/removed, a schema.json copied from
 * another machine, OR an in-place edit to a model's columns/comments/relations.
 * The primary signal is a content signature over every model file's name+source,
 * so content drift (not just filename drift) forces a recompile. Caches written
 * before signatures existed fall back to the model-file-name set. Absolute paths
 * are intentionally not compared (they legitimately differ across machines).
 */
export async function isCompiledSchemaStale(cachedSchema, modelsDir) {
  if (!cachedSchema || !Array.isArray(cachedSchema.tables)) {
    return true;
  }

  if (typeof cachedSchema.sourceSignature === 'string') {
    const signature = await computeModelsSignature(modelsDir);
    if (signature === null) {
      // Cannot inspect the models directory; trust the cache rather than fail.
      return false;
    }
    return cachedSchema.sourceSignature !== signature;
  }

  // Legacy cache without a signature: fall back to comparing model file names.
  const modelFiles = await listModelFileNames(modelsDir);
  if (!modelFiles) {
    return false;
  }
  return !setsAreEqual(modelFiles, cachedSchemaFileNames(cachedSchema));
}

export async function ensureCompiledSchema({ modelsDir, schemaPath, force = false }) {
  if (!force) {
    let cached = null;
    try {
      cached = JSON.parse(await fs.readFile(schemaPath, 'utf8'));
    } catch {
      cached = null;
    }

    if (cached && !(await isCompiledSchemaStale(cached, modelsDir))) {
      return cached;
    }
  }

  const schema = await compileSchemaFromModelsDir(modelsDir);
  await writeSchemaFile(schema, schemaPath);
  return schema;
}
