/**
 * @license
 * Copyright Google Inc. All Rights Reserved.
 *
 * Use of this source code is governed by an MIT-style license that can be
 * found in the LICENSE file at https://angular.io/license
 */

import {AstPath, BoundEventAst, CompileDirectiveSummary, CompileTypeMetadata, CssSelector, DirectiveAst, ElementAst, EmbeddedTemplateAst, HtmlAstPath, Identifiers, Node, ParseSourceSpan, RecursiveTemplateAstVisitor, RecursiveVisitor, TemplateAst, TemplateAstPath, identifierName, templateVisitAll, visitAll} from '@angular/compiler';
import * as ts from 'typescript';

import {AstResult, SelectorInfo} from './common';
import {DiagnosticTemplateInfo} from './expression_diagnostics';
import {Span, Symbol, SymbolQuery} from './types';

export interface SpanHolder {
  sourceSpan: ParseSourceSpan;
  endSourceSpan?: ParseSourceSpan|null;
  children?: SpanHolder[];
}

export function isParseSourceSpan(value: any): value is ParseSourceSpan {
  return value && !!value.start;
}

export function spanOf(span: SpanHolder): Span;
export function spanOf(span: ParseSourceSpan): Span;
export function spanOf(span: SpanHolder | ParseSourceSpan | undefined): Span|undefined;
export function spanOf(span?: SpanHolder | ParseSourceSpan): Span|undefined {
  if (!span) return undefined;
  if (isParseSourceSpan(span)) {
    return {start: span.start.offset, end: span.end.offset};
  } else {
    if (span.endSourceSpan) {
      return {start: span.sourceSpan.start.offset, end: span.endSourceSpan.end.offset};
    } else if (span.children && span.children.length) {
      return {
        start: span.sourceSpan.start.offset,
        end: spanOf(span.children[span.children.length - 1]) !.end
      };
    }
    return {start: span.sourceSpan.start.offset, end: span.sourceSpan.end.offset};
  }
}

export function inSpan(position: number, span?: Span, exclusive?: boolean): boolean {
  return span != null && (exclusive ? position >= span.start && position < span.end :
                                      position >= span.start && position <= span.end);
}

export function offsetSpan(span: Span, amount: number): Span {
  return {start: span.start + amount, end: span.end + amount};
}

export function isNarrower(spanA: Span, spanB: Span): boolean {
  return spanA.start >= spanB.start && spanA.end <= spanB.end;
}

export function hasTemplateReference(type: CompileTypeMetadata): boolean {
  for (const diDep of type.diDeps) {
    if (diDep.token && identifierName(diDep.token.identifier) === Identifiers.TemplateRef.name) {
      return true;
    }
  }
  return false;
}

export function getSelectors(info: AstResult): SelectorInfo {
  const map = new Map<CssSelector, CompileDirectiveSummary>();
  const results: CssSelector[] = [];
  for (const directive of info.directives) {
    const selectors: CssSelector[] = CssSelector.parse(directive.selector !);
    for (const selector of selectors) {
      results.push(selector);
      map.set(selector, directive);
    }
  }
  return {selectors: results, map};
}

export function isTypescriptVersion(low: string, high?: string) {
  const version = ts.version;

  if (version.substring(0, low.length) < low) return false;

  if (high && (version.substring(0, high.length) > high)) return false;

  return true;
}

export function diagnosticInfoFromTemplateInfo(info: AstResult): DiagnosticTemplateInfo {
  return {
    fileName: info.template.fileName,
    offset: info.template.span.start,
    query: info.template.query,
    members: info.template.members,
    htmlAst: info.htmlAst,
    templateAst: info.templateAst
  };
}

export function findTemplateAstAt(ast: TemplateAst[], position: number): TemplateAstPath {
  const path: TemplateAst[] = [];
  const visitor = new class extends RecursiveTemplateAstVisitor {
    visit(ast: TemplateAst): any {
      let span = spanOf(ast);
      if (inSpan(position, span)) {
        const len = path.length;
        if (!len || isNarrower(span, spanOf(path[len - 1]))) {
          path.push(ast);
        }
      } else {
        // Returning a value here will result in the children being skipped.
        return true;
      }
    }

    visitEmbeddedTemplate(ast: EmbeddedTemplateAst, context: any): any {
      return this.visitChildren(context, visit => {
        // Ignore reference, variable and providers
        visit(ast.attrs);
        visit(ast.directives);
        visit(ast.children);
      });
    }

    visitElement(ast: ElementAst, context: any): any {
      return this.visitChildren(context, visit => {
        // Ingnore providers
        visit(ast.attrs);
        visit(ast.inputs);
        visit(ast.outputs);
        visit(ast.references);
        visit(ast.directives);
        visit(ast.children);
      });
    }

    visitDirective(ast: DirectiveAst, context: any): any {
      // Ignore the host properties of a directive
      const result = this.visitChildren(context, visit => { visit(ast.inputs); });
      // We never care about the diretive itself, just its inputs.
      if (path[path.length - 1] === ast) {
        path.pop();
      }
      return result;
    }
  };

  templateVisitAll(visitor, ast);

  return new AstPath<TemplateAst>(path, position);
}

/**
 * Return the node that most tightly encompass the specified `position`.
 * @param node
 * @param position
 */
export function findTightestNode(node: ts.Node, position: number): ts.Node|undefined {
  if (node.getStart() <= position && position < node.getEnd()) {
    return node.forEachChild(c => findTightestNode(c, position)) || node;
  }
}

interface DirectiveClassLike {
  decoratorId: ts.Identifier;  // decorator identifier, like @Component
  classId: ts.Identifier;
}

/**
 * Return metadata about `node` if it looks like an Angular directive class.
 * In this case, potential matches are `@NgModule`, `@Component`, `@Directive`,
 * `@Pipe`, etc.
 * These class declarations all share some common attributes, namely their
 * decorator takes exactly one parameter and the parameter must be an object
 * literal.
 *
 * For example,
 *     v---------- `decoratorId`
 * @NgModule({           <
 *   declarations: [],   < classDecl
 * })                    <
 * class AppModule {}    <
 *          ^----- `classId`
 *
 * @param node Potential node that represents an Angular directive.
 */
export function getDirectiveClassLike(node: ts.Node): DirectiveClassLike|undefined {
  if (!ts.isClassDeclaration(node) || !node.name || !node.decorators) {
    return;
  }
  for (const d of node.decorators) {
    const expr = d.expression;
    if (!ts.isCallExpression(expr) || expr.arguments.length !== 1 ||
        !ts.isIdentifier(expr.expression)) {
      continue;
    }
    const arg = expr.arguments[0];
    if (ts.isObjectLiteralExpression(arg)) {
      return {
        decoratorId: expr.expression,
        classId: node.name,
      };
    }
  }
}

/**
 * Finds the value of a property assignment that is nested in a TypeScript node and is of a certain
 * type T.
 *
 * @param startNode node to start searching for nested property assignment from
 * @param propName property assignment name
 * @param predicate function to verify that a node is of type T.
 * @return node property assignment value of type T, or undefined if none is found
 */
export function findPropertyValueOfType<T extends ts.Node>(
    startNode: ts.Node, propName: string, predicate: (node: ts.Node) => node is T): T|undefined {
  if (ts.isPropertyAssignment(startNode) && startNode.name.getText() === propName) {
    const {initializer} = startNode;
    if (predicate(initializer)) return initializer;
  }
  return startNode.forEachChild(c => findPropertyValueOfType(c, propName, predicate));
}

/**
 * Find the tightest node at the specified `position` from the AST `nodes`, and
 * return the path to the node.
 * @param nodes HTML AST nodes
 * @param position
 */
export function getPathToNodeAtPosition(nodes: Node[], position: number): HtmlAstPath {
  const path: Node[] = [];
  const visitor = new class extends RecursiveVisitor {
    visit(ast: Node) {
      const span = spanOf(ast);
      if (inSpan(position, span)) {
        path.push(ast);
      } else {
        // Returning a truthy value here will skip all children and terminate
        // the visit.
        return true;
      }
    }
  };
  visitAll(visitor, nodes);
  return new AstPath<Node>(path, position);
}


/**
 * Inverts an object's key-value pairs.
 */
export function invertMap(obj: {[name: string]: string}): {[name: string]: string} {
  const result: {[name: string]: string} = {};
  for (const name of Object.keys(obj)) {
    const v = obj[name];
    result[v] = name;
  }
  return result;
}


/**
 * Finds the directive member providing a template output binding, if one exists.
 * @param info aggregate template AST information
 * @param path narrowing
 */
export function findOutputBinding(
    binding: BoundEventAst, path: TemplateAstPath, query: SymbolQuery): Symbol|undefined {
  const element = path.first(ElementAst);
  if (element) {
    for (const directive of element.directives) {
      const invertedOutputs = invertMap(directive.directive.outputs);
      const fieldName = invertedOutputs[binding.name];
      if (fieldName) {
        const classSymbol = query.getTypeSymbol(directive.directive.type.reference);
        if (classSymbol) {
          return classSymbol.members().get(fieldName);
        }
      }
    }
  }
}
