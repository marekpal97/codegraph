/**
 * Directory Node Generation
 *
 * Derives directory nodes and containment edges from the set of indexed file paths.
 * Called post-extraction to create the directory→file hierarchy that enables
 * agents to navigate by subsystem/package rather than individual files.
 */

import * as crypto from 'crypto';
import * as path from 'path';
import { Node, Edge } from '../types';

/**
 * Generate a deterministic node ID for a directory path.
 *
 * Uses the same `kind:hash` format as tree-sitter.ts generateNodeId()
 * but without line numbers (directories don't have them).
 */
export function generateDirectoryNodeId(dirPath: string): string {
  const hash = crypto
    .createHash('sha256')
    .update(`directory:${dirPath}`)
    .digest('hex')
    .substring(0, 32);
  return `directory:${hash}`;
}

/**
 * Build directory nodes and containment edges from a list of file paths.
 *
 * Given all indexed file paths (relative to project root), this function:
 * 1. Collects all unique directory prefixes
 * 2. Creates a Node for each directory
 * 3. Creates `contains` edges: parent dir → child dir, and dir → file
 *
 * The root directory is represented as '.' and is always included
 * when at least one file exists.
 *
 * @param filePaths - Relative file paths (e.g., 'src/auth/login.ts')
 * @returns Directory nodes and containment edges
 */
export function buildDirectoryNodes(filePaths: string[]): { nodes: Node[]; edges: Edge[] } {
  if (filePaths.length === 0) {
    return { nodes: [], edges: [] };
  }

  // Collect all unique directory paths from file paths
  const dirPaths = new Set<string>();
  dirPaths.add('.'); // Root is always present

  for (const filePath of filePaths) {
    const normalized = normalizeSeparators(filePath);
    let dir = path.posix.dirname(normalized);

    // Walk up from immediate parent to root, collecting all intermediate directories
    while (dir !== '.' && dir !== '') {
      dirPaths.add(dir);
      dir = path.posix.dirname(dir);
    }
  }

  // Create directory nodes
  const nodes: Node[] = [];
  const now = Date.now();

  for (const dirPath of dirPaths) {
    const name = dirPath === '.' ? '.' : path.posix.basename(dirPath);
    nodes.push({
      id: generateDirectoryNodeId(dirPath),
      kind: 'directory',
      name,
      qualifiedName: dirPath,
      filePath: dirPath,
      language: 'unknown',
      startLine: 0,
      endLine: 0,
      startColumn: 0,
      endColumn: 0,
      updatedAt: now,
    });
  }

  // Create containment edges
  const edges: Edge[] = [];

  // Directory → child directory edges
  for (const dirPath of dirPaths) {
    if (dirPath === '.') continue;
    const parentDir = path.posix.dirname(dirPath);
    const parentPath = parentDir === '' ? '.' : parentDir;

    if (dirPaths.has(parentPath)) {
      edges.push({
        source: generateDirectoryNodeId(parentPath),
        target: generateDirectoryNodeId(dirPath),
        kind: 'contains',
        provenance: 'heuristic',
      });
    }
  }

  // Directory → file edges
  for (const filePath of filePaths) {
    const normalized = normalizeSeparators(filePath);
    let parentDir = path.posix.dirname(normalized);
    if (parentDir === '' || parentDir === normalized) {
      parentDir = '.';
    }

    // File node IDs follow the convention from tree-sitter.ts line 944: `file:${filePath}`
    edges.push({
      source: generateDirectoryNodeId(parentDir),
      target: `file:${filePath}`,
      kind: 'contains',
      provenance: 'heuristic',
    });
  }

  return { nodes, edges };
}

/**
 * Normalize path separators to forward slashes for consistency.
 * Windows paths use backslashes but the graph stores forward slashes.
 */
function normalizeSeparators(p: string): string {
  return p.replace(/\\/g, '/');
}
