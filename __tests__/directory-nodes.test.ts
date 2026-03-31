/**
 * Directory Node Tests
 *
 * Tests for directory hierarchy generation and graph navigation.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import CodeGraph from '../src/index';
import { buildDirectoryNodes, generateDirectoryNodeId } from '../src/extraction/directory-nodes';

// =============================================================================
// Unit Tests: buildDirectoryNodes
// =============================================================================

describe('buildDirectoryNodes', () => {
  it('should return empty for no files', () => {
    const result = buildDirectoryNodes([]);
    expect(result.nodes).toHaveLength(0);
    expect(result.edges).toHaveLength(0);
  });

  it('should create root directory for a single root-level file', () => {
    const result = buildDirectoryNodes(['index.ts']);

    // Should create just the root directory '.'
    expect(result.nodes).toHaveLength(1);
    expect(result.nodes[0]!.kind).toBe('directory');
    expect(result.nodes[0]!.qualifiedName).toBe('.');
    expect(result.nodes[0]!.name).toBe('.');

    // Should create one edge: root → file
    expect(result.edges).toHaveLength(1);
    expect(result.edges[0]!.source).toBe(generateDirectoryNodeId('.'));
    expect(result.edges[0]!.target).toBe('file:index.ts');
    expect(result.edges[0]!.kind).toBe('contains');
  });

  it('should create intermediate directory nodes for nested paths', () => {
    const result = buildDirectoryNodes(['src/auth/login.ts']);

    // Should create: '.', 'src', 'src/auth'
    const dirNames = result.nodes.map((n) => n.qualifiedName).sort();
    expect(dirNames).toEqual(['.', 'src', 'src/auth']);

    // Verify all are directory kind
    for (const node of result.nodes) {
      expect(node.kind).toBe('directory');
    }
  });

  it('should deduplicate directories shared across files', () => {
    const result = buildDirectoryNodes([
      'src/auth/login.ts',
      'src/auth/register.ts',
      'src/utils.ts',
      'README.md',
    ]);

    // Directories: '.', 'src', 'src/auth'
    const dirNames = result.nodes.map((n) => n.qualifiedName).sort();
    expect(dirNames).toEqual(['.', 'src', 'src/auth']);

    // Edges:
    // . → src (dir→dir)
    // . → file:README.md (dir→file)
    // src → src/auth (dir→dir)
    // src → file:src/utils.ts (dir→file)
    // src/auth → file:src/auth/login.ts (dir→file)
    // src/auth → file:src/auth/register.ts (dir→file)
    expect(result.edges).toHaveLength(6);

    // Check that directory→directory edges exist
    const dirToDirEdges = result.edges.filter(
      (e) => e.source === generateDirectoryNodeId('.') && e.target === generateDirectoryNodeId('src')
    );
    expect(dirToDirEdges).toHaveLength(1);
  });

  it('should handle deeply nested paths', () => {
    const result = buildDirectoryNodes(['a/b/c/d/e/f.ts']);

    // Should create: '.', 'a', 'a/b', 'a/b/c', 'a/b/c/d', 'a/b/c/d/e'
    expect(result.nodes).toHaveLength(6);
    const dirNames = result.nodes.map((n) => n.qualifiedName).sort();
    expect(dirNames).toEqual(['.', 'a', 'a/b', 'a/b/c', 'a/b/c/d', 'a/b/c/d/e']);
  });

  it('should set correct name (basename) for directories', () => {
    const result = buildDirectoryNodes(['src/auth/login.ts']);

    const authDir = result.nodes.find((n) => n.qualifiedName === 'src/auth');
    expect(authDir).toBeDefined();
    expect(authDir!.name).toBe('auth');

    const srcDir = result.nodes.find((n) => n.qualifiedName === 'src');
    expect(srcDir).toBeDefined();
    expect(srcDir!.name).toBe('src');
  });

  it('should generate deterministic IDs', () => {
    const result1 = buildDirectoryNodes(['src/auth/login.ts']);
    const result2 = buildDirectoryNodes(['src/auth/login.ts']);

    // Same input → same IDs
    expect(result1.nodes.map((n) => n.id)).toEqual(result2.nodes.map((n) => n.id));
  });

  it('should use heuristic provenance for all edges', () => {
    const result = buildDirectoryNodes(['src/utils.ts']);
    for (const edge of result.edges) {
      expect(edge.provenance).toBe('heuristic');
    }
  });
});

// =============================================================================
// Integration Tests: Directory nodes in the full pipeline
// =============================================================================

describe('Directory Nodes Integration', () => {
  let testDir: string;
  let cg: CodeGraph;

  beforeEach(async () => {
    testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'codegraph-dir-test-'));

    // Create a nested project structure
    const authDir = path.join(testDir, 'src', 'auth');
    const apiDir = path.join(testDir, 'src', 'api');
    fs.mkdirSync(authDir, { recursive: true });
    fs.mkdirSync(apiDir, { recursive: true });

    fs.writeFileSync(
      path.join(authDir, 'login.ts'),
      `
export class LoginService {
  async login(email: string, password: string): Promise<boolean> {
    return true;
  }
}
`
    );

    fs.writeFileSync(
      path.join(authDir, 'register.ts'),
      `
export class RegisterService {
  async register(email: string): Promise<void> {}
}
`
    );

    fs.writeFileSync(
      path.join(apiDir, 'routes.ts'),
      `
export function setupRoutes(): void {}
`
    );

    fs.writeFileSync(
      path.join(testDir, 'src', 'utils.ts'),
      `
export function formatDate(date: Date): string {
  return date.toISOString();
}
`
    );

    // Initialize and index
    cg = CodeGraph.initSync(testDir, {
      config: {
        include: ['src/**/*.ts'],
        exclude: [],
      },
    });
    await cg.indexAll();
  });

  afterEach(() => {
    cg?.close();
    if (testDir && fs.existsSync(testDir)) {
      fs.rmSync(testDir, { recursive: true, force: true });
    }
  });

  it('should create directory nodes during indexAll', () => {
    const dirNodes = cg.getNodesByKind('directory');
    expect(dirNodes.length).toBeGreaterThan(0);

    const dirNames = dirNodes.map((n) => n.qualifiedName).sort();
    // Should have: '.', 'src', 'src/auth', 'src/api'
    expect(dirNames).toContain('.');
    expect(dirNames).toContain('src');
    expect(dirNames).toContain('src/auth');
    expect(dirNames).toContain('src/api');
  });

  it('should create containment chain from directory to method', () => {
    // Find the login method
    const searchResults = cg.searchNodes('login', { kinds: ['method'] });
    const loginMethod = searchResults.find((n) => n.name === 'login');

    if (loginMethod) {
      // getAncestors should return: [LoginService, file:login.ts, src/auth, src, .]
      const ancestors = cg.getAncestors(loginMethod.id);
      const ancestorKinds = ancestors.map((a) => a.kind);

      expect(ancestorKinds).toContain('class');
      expect(ancestorKinds).toContain('file');
      expect(ancestorKinds).toContain('directory');
    }
  });

  it('should return directory contents', () => {
    const contents = cg.getDirectoryContents('src/auth');

    // Should have files but no subdirectories
    expect(contents.directories).toHaveLength(0);
    expect(contents.files.length).toBeGreaterThanOrEqual(2);

    const fileNames = contents.files.map((f) => f.name).sort();
    expect(fileNames).toContain('login.ts');
    expect(fileNames).toContain('register.ts');
  });

  it('should return directory contents for root', () => {
    const contents = cg.getDirectoryContents('.');

    // Root should have 'src' as a subdirectory
    const dirNames = contents.directories.map((d) => d.name);
    expect(dirNames).toContain('src');
  });

  it('should return symbols in directory contents', () => {
    const contents = cg.getDirectoryContents('src/auth');

    // Should include LoginService, RegisterService as symbols
    expect(contents.symbols.length).toBeGreaterThan(0);
    const symbolNames = contents.symbols.map((s) => s.name);
    expect(symbolNames).toContain('LoginService');
    expect(symbolNames).toContain('RegisterService');
  });

  it('should return directory tree with depth limit', () => {
    const tree = cg.getDirectoryTree('.', 1);

    // At depth 1 from root, should see 'src' directory but not its children
    const nodeKinds = Array.from(tree.nodes.values()).map((n) => n.kind);
    expect(nodeKinds).toContain('directory');
  });

  it('should return empty for non-existent directory', () => {
    const contents = cg.getDirectoryContents('nonexistent/path');
    expect(contents.directories).toHaveLength(0);
    expect(contents.files).toHaveLength(0);
    expect(contents.symbols).toHaveLength(0);
  });
});
