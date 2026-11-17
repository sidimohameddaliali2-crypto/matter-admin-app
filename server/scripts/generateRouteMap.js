import { parse } from '@babel/parser';
import { readFileSync, writeFileSync, readdirSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const check = process.argv.includes('--check');
const modules = new Map();
const methods = new Set(['get', 'post', 'put', 'patch', 'delete', 'head', 'options', 'all']);
const join = (a, b) => `${a}/${b}`.replace(/\/+/g, '/').replace(/\/$/, '') || '/';
const literal = (node) =>
  node?.type === 'StringLiteral'
    ? [node.value]
    : node?.type === 'ArrayExpression'
      ? node.elements.flatMap(literal)
      : [];
const walk = (node, visit) => {
  if (!node || typeof node !== 'object') return;
  if (Array.isArray(node)) {
    node.forEach((item) => walk(item, visit));
    return;
  }
  if (node.type) visit(node);
  for (const [key, value] of Object.entries(node))
    if (!['loc', 'comments', 'tokens'].includes(key)) walk(value, visit);
};
const files = (directory) =>
  readdirSync(path.join(root, directory), { withFileTypes: true }).flatMap((entry) => {
    const file = `${directory}/${entry.name}`;
    return entry.isDirectory()
      ? files(file)
      : file.endsWith('.js') && !file.endsWith('.test.js')
        ? [file]
        : [];
  });

function load(file) {
  if (modules.has(file)) return modules.get(file);
  const source = readFileSync(path.join(root, file), 'utf8');
  const ast = parse(source, { sourceType: 'module', plugins: ['jsx'] });
  const record = {
    file,
    source,
    ast,
    imports: new Map(),
    factories: new Map(),
    routes: [],
    mounts: [],
    guards: [],
    routerNames: new Set(['app', 'router']),
  };
  modules.set(file, record);
  const text = (node) => source.slice(node.start, node.end).replace(/\s+/g, ' ');
  const declaration = (node) => {
    let callback = false;
    walk(node, (child) => {
      if (['ArrowFunctionExpression', 'FunctionExpression'].includes(child.type)) callback = true;
    });
    return callback ? null : text(node);
  };
  for (const node of ast.program.body) {
    if (node.type !== 'ImportDeclaration' || !node.source.value.startsWith('.')) continue;
    const target = path.posix.normalize(
      path.posix.join(path.posix.dirname(file), node.source.value),
    );
    for (const specifier of node.specifiers) record.imports.set(specifier.local.name, target);
  }
  walk(ast, (node) => {
    if (
      node.type === 'CallExpression' &&
      node.callee.type === 'Identifier' &&
      record.imports.get(node.callee.name) === 'server/services/customerServiceAdminMount.js'
    ) {
      record.mounts.push({
        router: 'app',
        paths: [''],
        refs: [{ file: 'server/services/customerServiceAdminMount.js', router: 'app' }],
        offset: node.start,
      });
    }
    if (
      node.type === 'VariableDeclarator' &&
      node.id.type === 'Identifier' &&
      node.init?.type === 'CallExpression'
    ) {
      if (
        node.init.callee.type === 'MemberExpression' &&
        node.init.callee.property.name === 'Router'
      )
        record.routerNames.add(node.id.name);
      const name = node.init.callee.name;
      if (record.imports.has(name)) record.factories.set(node.id.name, record.imports.get(name));
    }
    if (node.type !== 'CallExpression' || node.callee.type !== 'MemberExpression') return;
    const object = node.callee.object;
    const method = node.callee.property.name;
    if (object.type !== 'Identifier' || !record.routerNames.has(object.name)) return;
    const paths = literal(node.arguments[0]);
    const sourceRef = `${file}:${node.loc.start.line}`;
    if (methods.has(method) && paths.length && node.arguments.length > 1) {
      const comment = ast.comments
        .filter((c) => c.end < node.start && node.loc.start.line - c.loc.end.line < 9)
        .map((c) => c.value)
        .join(' ');
      const description =
        comment
          .match(/@desc\s+([^@]+)/)?.[1]
          ?.trim()
          .replace(/\s+/g, ' ') || null;
      const guards = node.arguments.slice(1).map(declaration).filter(Boolean);
      const statuses = new Set();
      const responseKeys = new Set();
      const calls = new Set();
      const requestKeys = new Set();
      walk(node.arguments.slice(1), (child) => {
        if (
          child.type === 'MemberExpression' &&
          child.object.type === 'MemberExpression' &&
          child.object.object.name === 'req' &&
          ['body', 'query', 'params'].includes(child.object.property.name) &&
          child.property.name
        )
          requestKeys.add(child.object.property.name + '.' + child.property.name);
        if (
          child.type === 'VariableDeclarator' &&
          child.id.type === 'ObjectPattern' &&
          child.init?.type === 'MemberExpression' &&
          child.init.object.name === 'req' &&
          ['body', 'query', 'params'].includes(child.init.property.name)
        ) {
          child.id.properties.forEach((property) => {
            if (property.key?.name)
              requestKeys.add(child.init.property.name + '.' + property.key.name);
          });
        }
        if (child.type === 'CallExpression' && child.callee.type === 'Identifier') {
          const target = record.imports.get(child.callee.name);
          if (target?.includes('/services/')) calls.add(child.callee.name);
        }
        if (child.type !== 'CallExpression' || child.callee.type !== 'MemberExpression') return;
        const member = child.callee;
        if (
          ['status', 'sendStatus'].includes(member.property.name) &&
          child.arguments[0]?.type === 'NumericLiteral'
        )
          statuses.add(child.arguments[0].value);
        if (member.property.name === 'json' && child.arguments[0]?.type === 'ObjectExpression') {
          child.arguments[0].properties.forEach((p) => {
            if (p.key?.name) responseKeys.add(p.key.name);
          });
        }
        if (member.object.type === 'Identifier') {
          const target = record.imports.get(member.object.name);
          if (target?.includes('/models/') || target?.includes('/services/'))
            calls.add(`${member.object.name}.${member.property.name}`);
        }
      });
      paths.forEach((route) =>
        record.routes.push({
          router: object.name,
          method: method.toUpperCase(),
          localPath: route,
          source: sourceRef,
          description,
          handlerGuards: guards,
          declaredStatuses: [...statuses].sort(),
          responseKeys: [...responseKeys].sort(),
          requestKeys: [...requestKeys].sort(),
          referencedCalls: [...calls].sort(),
          offset: node.start,
        }),
      );
    }
    if (method === 'use') {
      const handlers = paths.length ? node.arguments.slice(1) : node.arguments;
      const refs = handlers
        .map((handler) => {
          if (handler.type === 'Identifier') {
            if (record.routerNames.has(handler.name)) return { file, router: handler.name };
            return record.imports.get(handler.name) || record.factories.get(handler.name);
          }
          if (handler.type === 'MemberExpression') return record.factories.get(handler.object.name);
          if (handler.type === 'CallExpression') return record.imports.get(handler.callee.name);
          return null;
        })
        .filter(Boolean);
      if (refs.length)
        record.mounts.push({
          paths: paths.length ? paths : [''],
          refs,
          source: sourceRef,
          router: object.name,
          offset: node.start,
        });
      record.guards.push({
        router: object.name,
        paths,
        text: handlers.map(declaration).filter(Boolean),
        offset: node.start,
      });
    }
  });
  return record;
}

const mounted = [];
const visited = new Set();
const reached = new Set();
function mount(file, prefix = '', ancestry = [], router = 'router') {
  const key = file + '|' + prefix + '|' + router;
  if (visited.has(key) || ancestry.includes(file + '|' + router)) return;
  visited.add(key);
  const record = load(file);
  reached.add(file);
  const entries = [...record.routes, ...record.mounts]
    .filter((entry) => entry.router === router)
    .sort((a, b) => a.offset - b.offset);
  for (const entry of entries) {
    if (entry.method) {
      mounted.push({
        ...entry,
        path: join(prefix, entry.localPath),
        middlewareDeclarations: record.guards
          .filter(
            (g) =>
              g.router === router &&
              g.offset < entry.offset &&
              (!g.paths.length || g.paths.some((p) => entry.localPath.startsWith(p))),
          )
          .flatMap((g) => g.text),
      });
      continue;
    }
    for (const prefixPart of entry.paths)
      for (const ref of entry.refs) {
        const target = typeof ref === 'string' ? { file: ref, router: 'router' } : ref;
        if (
          target.file.startsWith('server/routes/') ||
          target.file === 'server/services/customerServiceAdminMount.js'
        )
          mount(
            target.file,
            join(prefix, prefixPart),
            [...ancestry, file + '|' + router],
            target.router,
          );
      }
  }
}
mount('server/server.js', '', [], 'app');

const boundaries = [
  {
    path: '/report-data/*',
    source: 'server/services/driverAuditIntegration.js',
    meaning: 'Private immutable report data dispatched to the imported runtime.',
  },
  {
    path: '/report-assets/*',
    source: 'server/services/driverAuditIntegration.js',
    meaning: 'Report assets dispatched through the audit handler.',
  },
  ...['authorize', 'token', 'register', 'revoke'].map((name) => ({
    path: '/api/mcp/oauth/' + name,
    source: 'server/routes/mcpOAuth.js',
    meaning:
      'OAuth SDK middleware. Method validation, protocol responses and authorization are delegated to the SDK.',
  })),
  {
    path: '/api/driver-audits/session',
    source: 'server/services/driverAuditIntegration.js',
    meaning:
      'Raw HTTP handler; staff session, report resources and delegated imported runtime. See that handler and server/vendor/driver-audits for exact dispatch. Wildcard is a boundary, not an enumerated endpoint.',
  },
  {
    path: '/api/reporting/*',
    source: 'server/services/driverAuditIntegration.js',
    meaning:
      'Compatibility report handler; conditional on Driver Audit configuration and imported runtime.',
  },
  {
    path: '/driver-audit-view',
    source: 'server/services/driverAuditIntegration.js',
    meaning: 'Legacy audit document served by raw handler.',
  },
  {
    path: '/api/session',
    source: 'server/services/driverAuditIntegration.js',
    meaning: 'Audit session compatibility endpoint; distinct from app staff login.',
  },
  {
    path: '/api/session/refresh',
    source: 'server/services/driverAuditIntegration.js',
    meaning: 'Audit session refresh compatibility endpoint.',
  },
  {
    path: '/api/customer-service-capture/*',
    source: 'server/services/customerServiceDestination.js',
    meaning: 'Readiness gate only in this app; capture worker is independently owned.',
  },
  {
    path: '/uploads/*',
    source: 'server/server.js',
    meaning: 'Static upload files; HTTP completion does not establish evidence validity.',
  },
  {
    path: '/socket.io/*',
    source: 'server/server.js',
    meaning:
      'Engine.IO transport bypasses Express request middleware; connection/event coverage is separate.',
  },
  {
    path: '/*',
    source: 'server/server.js',
    meaning:
      'CRA assets and SPA fallback; browser navigation may return index.html without a matching page.',
  },
];
const api = mounted.map(({ offset, localPath, router, ...route }) => ({
  id: createHash('sha256')
    .update(`${route.method} ${route.path} ${route.source.split(':')[0]}`)
    .digest('hex')
    .slice(0, 16),
  ...route,
}));
const browser = [];
const app = load('client/src/App.js');
walk(app.ast, (node) => {
  if (node.type !== 'JSXElement' || node.openingElement.name.name !== 'Route') return;
  const attr = node.openingElement.attributes.find((a) => a.name?.name === 'path');
  if (!attr?.value?.value) return;
  const elements = [];
  const guardAttributes = [];
  walk(node, (item) => {
    if (item.type === 'JSXOpeningElement') elements.push(item.name.name);
    if (
      item.type === 'JSXAttribute' &&
      [
        'permission',
        'allowedRoles',
        'allowDrivers',
        'allowDispatchers',
        'allowStoreKeepers',
        'allowKitchen',
        'allowYellowblock',
      ].includes(item.name?.name)
    ) {
      guardAttributes.push(app.source.slice(item.start, item.end));
    }
  });
  browser.push({
    path: attr.value.value,
    source: `client/src/App.js:${node.loc.start.line}`,
    elements: [...new Set(elements)].filter((n) => n !== 'Route'),
    guardAttributes,
  });
});
const unmounted = files('server/routes')
  .filter((file) => !reached.has(file))
  .map((file) => ({ file, declarations: load(file).routes.length }));
// Raw handlers are inventoried as dispatch evidence because their method and path
// predicates are not declarative Express registrations.
const rawDispatch = [];
for (const file of [
  'server/services/driverAuditIntegration.js',
  'server/vendor/driver-audits/integration/cloud/cloud-http.mjs',
]) {
  const record = load(file);
  walk(record.ast, (node) => {
    if (
      node.type === 'StringLiteral' &&
      /^\/(api|report-data|report-assets)(\/|$)/.test(node.value)
    ) {
      rawDispatch.push({ pathLiteral: node.value, source: file + ':' + node.loc.start.line });
    }
    if (node.type === 'RegExpLiteral' && /report|photo|font/.test(node.pattern)) {
      rawDispatch.push({ pathPattern: node.pattern, source: file + ':' + node.loc.start.line });
    }
  });
}
const socketEvents = [];
for (const file of [
  'server/server.js',
  'server/middleware/socketAuth.js',
  ...files('server/routes'),
]) {
  const record = load(file);
  walk(record.ast, (node) => {
    if (
      node.type !== 'CallExpression' ||
      node.callee.type !== 'MemberExpression' ||
      !['on', 'emit'].includes(node.callee.property.name)
    )
      return;
    const event = literal(node.arguments[0])[0];
    if (event && (event.includes(':') || ['connection', 'disconnect'].includes(event)))
      socketEvents.push({
        event,
        direction: node.callee.property.name,
        source: file + ':' + node.loc.start.line,
      });
  });
}
const sourceDigests = Object.fromEntries(
  [...modules]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([file, record]) => [file, createHash('sha256').update(record.source).digest('hex')]),
);
const guide = readFileSync(path.join(root, 'docs/traceability/README.md'), 'utf8');
const areaSection =
  guide.split('## What the app areas mean')[1]?.split('## Data vocabulary')[0] || '';
const areas = areaSection
  .split('\n')
  .filter((line) => line.startsWith('| ') && line.includes('\x60'))
  .map((line) => {
    const [, paths, meaning] = line.split('|');
    return { paths: paths.replaceAll('\x60', '').trim(), meaning: meaning.trim() };
  });
const manifest = {
  areas,
  sourceDigests,
  schemaVersion: 1,
  scope:
    'Static source declarations. Conditional mounts are included; live enablement and permissions require runtime verification.',
  api,
  browser,
  boundaries,
  rawDispatch,
  socketEvents,
  unmounted,
};
const link = (ref) => {
  const [file, line] = ref.split(':');
  return `[${ref}](../../${file}${line ? `#L${line}` : ''})`;
};
const clean = (value) =>
  String(value || '')
    .replaceAll('|', '\\|')
    .replaceAll('\n', ' ');
const markdown =
  `# Matter route map\n\nGenerated by \`npm --prefix server run traceability:map\`. Source declarations are the evidence. Middleware text is an ordered declaration, not proof of effective authorization. Handler statuses/keys cover inline code only; called functions, imported handlers and SDKs can add behavior. GET can invoke refreshes or other side effects. HEAD may reuse GET; Express also supplies OPTIONS. Duplicate declarations retain registration order.\n\n${api.length} mounted API declarations, ${browser.length} browser routes, ${boundaries.length} special boundaries.\n\nRead [interpretation and operations](README.md) alongside this map. Machine-readable details are in [routes.json](routes.json).\n\n## API declarations\n\n| Method | Path | Description from code | Direct inputs / response keys / calls | Declared middleware and guards | Inline statuses | Source |\n| --- | --- | --- | --- | --- | --- | --- |\n` +
  api
    .map(
      (r) =>
        `| ${r.method} | \`${clean(r.path)}\` | ${clean(r.description || 'See area meaning in README and direct calls in this row.')} | ${clean([r.requestKeys.length ? 'Inputs ' + r.requestKeys.join(', ') : '', r.responseKeys.length ? 'Returns ' + r.responseKeys.join(', ') : '', r.referencedCalls.length ? 'Calls ' + r.referencedCalls.join(', ') : ''].filter(Boolean).join(' / '))} | ${clean([...r.middlewareDeclarations, ...r.handlerGuards].join(' → ')) || 'No named guard found locally; inspect mount and handler.'} | ${r.declaredStatuses.join(', ') || 'Default or delegated'} | ${link(r.source)} |`,
    )
    .join('\n') +
  `\n\n## Browser routes\n\n| Path | Elements and guards | Guard attributes | Source |\n| --- | --- | --- | --- |\n` +
  browser
    .map(
      (r) =>
        `| \`${r.path}\` | ${r.elements.join(' → ')} | ${clean(r.guardAttributes.join(', '))} | ${link(r.source)} |`,
    )
    .join('\n') +
  `\n\n## Special boundaries\n\n` +
  boundaries.map((r) => `- \`${r.path}\` — ${r.meaning} ${link(r.source)}`).join('\n') +
  `\n\n## Raw dispatch evidence\n\nPath literals and patterns below come from raw handlers, including delegated reporting code. Each needs its surrounding method/configuration predicate to establish reachability. Repetition retains source locations.\n\n` +
  rawDispatch
    .map((r) => '- \`' + (r.pathLiteral || r.pathPattern) + '\` — ' + link(r.source))
    .join('\n') +
  `\n\n## Socket event declarations\n\n` +
  socketEvents
    .map((r) => '- \`' + r.event + '\` (' + r.direction + ') — ' + link(r.source))
    .join('\n') +
  `\n\n## Files without a resolved mount\n\nThese files may be unused, mounted through another mechanism, or reached through a delegated runtime. They are not assumed to be live routes.\n\n` +
  unmounted.map((r) => `- ${link(r.file)} — ${r.declarations} declarations.`).join('\n') +
  '\n';
mkdirSync(path.join(root, 'docs/traceability'), { recursive: true });
for (const [file, body] of [
  ['docs/traceability/routes.json', JSON.stringify(manifest, null, 2) + '\n'],
  ['docs/traceability/ROUTES.md', markdown],
]) {
  if (check) {
    if (readFileSync(path.join(root, file), 'utf8') !== body)
      throw Error(`Route map is stale: ${file}. Run npm --prefix server run traceability:map`);
  } else writeFileSync(path.join(root, file), body);
}
console.log(
  `${check ? 'Verified' : 'Generated'} ${api.length} API declarations and ${browser.length} browser routes; ${unmounted.length} unresolved route files.`,
);
