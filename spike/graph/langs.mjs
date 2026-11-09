// Supported languages: WASM grammar, extensions and tree-sitter queries.
//
// Capture convention (the extractor is generic and only understands these):
//   @def.<kind> + @name        definition (function, method, class, interface, type, enum, struct, trait, const, property, module)
//   @owner                     inside a @def.method: name of the owning type (Go receiver)
//   @container + @owner        block that gives owners to the methods inside without being a symbol (Rust impl)
//   @import                    import node; the text is interpreted by the language's `imports(node)`
//   @call + @callee [+ @receiver]   call
//   @new + @callee [+ @receiver]    instantiation
//   @jsx + @callee             JSX component used
//   @type                      type reference
//   @ref                       identifier passed as a value (callback, prop)
//   @extends / @implements     inheritance of the class enclosing the node (or of @owner, if any)
//   @bind.name + @bind.type    variable/parameter with known type (scope: enclosing function)
//   @field.name + @field.type  class field with known type (accessed via this./self.)
//   @bindcall.name + @bindcall.callee   variable that receives a call's return (type comes from the signature)
//   @export.default            identifier exported as default

const JS_COMMON = `
(function_declaration name: (identifier) @name) @def.function
(generator_function_declaration name: (identifier) @name) @def.function
(class_declaration name: (_) @name) @def.class
(class name: (_) @name) @def.class
(method_definition name: (_) @name) @def.method
(lexical_declaration (variable_declarator name: (identifier) @name value: [(arrow_function) (function_expression)]) @def.function)
(variable_declaration (variable_declarator name: (identifier) @name value: [(arrow_function) (function_expression)]) @def.function)
(lexical_declaration (variable_declarator name: (identifier) @name value: (call_expression function: (_) @_hook (#match? @_hook "(^|\\.)(useCallback|useMemo|memo|forwardRef|useEffectEvent|debounce|throttle|once)$") arguments: (arguments . [(arrow_function) (function_expression)]))) @def.function)
(lexical_declaration (variable_declarator name: (identifier) @name) @def.const)
(variable_declaration (variable_declarator name: (identifier) @name) @def.const)
(call_expression function: (identifier) @_t (#match? @_t "^(describe|it|test)$") arguments: (arguments . [(string) (template_string)] @name)) @def.test
(variable_declarator value: (object (pair key: (property_identifier) @name value: [(arrow_function) (function_expression)]) @def.method))
(field_definition property: (property_identifier) @name value: [(arrow_function) (function_expression)]) @def.method
(public_field_definition name: (property_identifier) @name value: [(arrow_function) (function_expression)]) @def.method
(public_field_definition name: (property_identifier) @name) @def.property

(import_statement) @import
(export_statement source: (_)) @import
(call_expression function: (identifier) @_req (#eq? @_req "require") arguments: (arguments (string))) @import
(call_expression function: (import) arguments: (arguments (string))) @import

(call_expression function: (identifier) @callee) @call
(call_expression function: (member_expression object: (_) @receiver property: (_) @callee)) @call
(new_expression constructor: (identifier) @callee) @new
(new_expression constructor: (member_expression object: (_) @receiver property: (_) @callee)) @new
(arguments (identifier) @ref)
(arguments (member_expression object: (this) property: (property_identifier) @ref))
(pair value: (identifier) @ref)
(shorthand_property_identifier) @ref
(class_heritage (identifier) @extends)
(class_heritage (member_expression) @extends)

(variable_declarator name: (identifier) @bind.name value: (new_expression constructor: (_) @bind.type))
(variable_declarator name: (identifier) @bind.name value: (await_expression (new_expression constructor: (_) @bind.type)))
(variable_declarator name: (identifier) @bindcall.name value: (call_expression function: (_) @bindcall.callee))
(variable_declarator name: (identifier) @bindcall.name value: (await_expression (call_expression function: (_) @bindcall.callee)))
(assignment_expression left: (member_expression object: (this) property: (property_identifier) @field.name) right: (new_expression constructor: (_) @field.type))
(variable_declarator name: (identifier) @bindexpr.name value: [(member_expression) (identifier)] @bindexpr.value)
(variable_declarator name: (identifier) @bindexpr.name value: (await_expression [(member_expression) (identifier)] @bindexpr.value))
(variable_declarator name: (object_pattern (shorthand_property_identifier_pattern) @binddestr.name) value: [(member_expression) (identifier)] @binddestr.value)
(variable_declarator name: (object_pattern (shorthand_property_identifier_pattern) @bdc.name) value: (call_expression function: (_) @bdc.callee))
(variable_declarator name: (object_pattern (shorthand_property_identifier_pattern) @bdc.name) value: (await_expression (call_expression function: (_) @bdc.callee)))
(export_statement "default" (identifier) @export.default)
`

const TS_ONLY = `
(abstract_class_declaration name: (_) @name) @def.class
(interface_declaration name: (_) @name) @def.interface
(type_alias_declaration name: (_) @name) @def.type
(enum_declaration name: (_) @name) @def.enum
(internal_module name: (_) @name) @def.module
(abstract_method_signature name: (_) @name) @def.method
(method_signature name: (_) @name) @def.method
(function_signature name: (identifier) @name) @def.function

(type_annotation (type_identifier) @type)
(type_annotation (generic_type name: (type_identifier) @type))
(type_arguments (type_identifier) @type)
(union_type (type_identifier) @type)
(extends_clause value: (_) @extends)
(implements_clause (type_identifier) @implements)
(implements_clause (generic_type name: (type_identifier) @implements))
(extends_type_clause type: (type_identifier) @extends)
(satisfies_expression (type_identifier) @type)
(as_expression (type_identifier) @type)

(required_parameter (accessibility_modifier) pattern: (identifier) @field.name type: (type_annotation (_) @field.type))
(optional_parameter (accessibility_modifier) pattern: (identifier) @field.name type: (type_annotation (_) @field.type))
(required_parameter "readonly" pattern: (identifier) @field.name type: (type_annotation (_) @field.type))
(optional_parameter "readonly" pattern: (identifier) @field.name type: (type_annotation (_) @field.type))
(required_parameter pattern: (identifier) @bind.name type: (type_annotation (_) @bind.type))
(optional_parameter pattern: (identifier) @bind.name type: (type_annotation (_) @bind.type))
(public_field_definition name: (property_identifier) @field.name type: (type_annotation (_) @field.type))
(public_field_definition name: (property_identifier) @field.name value: (new_expression constructor: (_) @field.type))
(variable_declarator name: (identifier) @bind.name type: (type_annotation (_) @bind.type))
(interface_body (property_signature name: (property_identifier) @field.name type: (type_annotation (_) @field.type)))
(type_alias_declaration value: (object_type (property_signature name: (property_identifier) @field.name type: (type_annotation (_) @field.type))))
`

const JSX = `
(jsx_opening_element name: (identifier) @callee) @jsx
(jsx_self_closing_element name: (identifier) @callee) @jsx
(jsx_opening_element name: (member_expression object: (_) @receiver property: (_) @callee)) @jsx
(jsx_self_closing_element name: (member_expression object: (_) @receiver property: (_) @callee)) @jsx
(jsx_expression (identifier) @ref)
`

// ---- import interpretation per language ----------------------------------------------------------------------

const str = (n) => n?.text.replace(/^['"`]|['"`]$/g, '')

function jsImports(node) {
  const out = []
  if (node.type === 'call_expression') {
    const arg = node.childForFieldName('arguments')?.namedChildren[0]
    const spec = str(arg)
    // const { a, b: c } = require('x')  |  const x = require('x')
    const decl = node.parent?.type === 'variable_declarator' ? node.parent : node.parent?.type === 'await_expression' && node.parent.parent?.type === 'variable_declarator' ? node.parent.parent : null
    const pat = decl?.childForFieldName('name')
    if (pat?.type === 'identifier') out.push({ spec, local: pat.text, imported: '*' })
    else if (pat?.type === 'object_pattern') {
      for (const p of pat.namedChildren) {
        if (p.type === 'shorthand_property_identifier_pattern') out.push({ spec, local: p.text, imported: p.text })
        else if (p.type === 'pair_pattern') out.push({ spec, local: p.childForFieldName('value')?.text, imported: p.childForFieldName('key')?.text })
      }
    } else out.push({ spec, local: null, imported: null })
    return out
  }
  const spec = str(node.childForFieldName('source'))
  if (node.type === 'export_statement') {
    // export * from 'x' | export * as ns from 'x' | export { a, b as c } from 'x'
    const clause = node.namedChildren.find((c) => c.type === 'export_clause')
    const ns = node.namedChildren.find((c) => c.type === 'namespace_export')
    if (clause) for (const s of clause.namedChildren) out.push({ spec, local: (s.childForFieldName('alias') ?? s.childForFieldName('name')).text, imported: s.childForFieldName('name').text, reexport: 1 })
    else if (ns) out.push({ spec, local: ns.namedChildren.at(-1)?.text, imported: '*', reexport: 1 })
    else out.push({ spec, local: '*', imported: '*', reexport: 1 })
    return out
  }
  const clause = node.namedChildren.find((c) => c.type === 'import_clause')
  if (!clause) return [{ spec, local: null, imported: null }]
  for (const c of clause.namedChildren) {
    if (c.type === 'identifier') out.push({ spec, local: c.text, imported: 'default' })
    else if (c.type === 'namespace_import') out.push({ spec, local: c.namedChildren.at(-1)?.text, imported: '*' })
    else if (c.type === 'named_imports') for (const s of c.namedChildren) if (s.type === 'import_specifier') out.push({ spec, local: (s.childForFieldName('alias') ?? s.childForFieldName('name')).text, imported: s.childForFieldName('name').text })
  }
  return out
}

function pyImports(node) {
  const out = []
  const item = (n, spec) => {
    if (n.type === 'aliased_import') return { spec, local: n.childForFieldName('alias').text, imported: n.childForFieldName('name').text }
    return { spec, local: n.text.split('.').at(-1), imported: n.text }
  }
  if (node.type === 'import_statement') {
    for (const n of node.namedChildren) {
      if (n.type === 'aliased_import') out.push({ spec: n.childForFieldName('name').text, local: n.childForFieldName('alias').text, imported: '*' })
      else out.push({ spec: n.text, local: n.text.split('.')[0], imported: n.text.includes('.') ? 'pkg' : '*' })
    }
    return out
  }
  const modNode = node.childForFieldName('module_name')
  const mod = modNode?.text ?? ''
  for (const n of node.namedChildren) {
    // (web-tree-sitter nodes are not the same object on every call: compare by position)
    if (modNode && n.startIndex === modNode.startIndex) continue
    if (n.type === 'wildcard_import') out.push({ spec: mod, local: '*', imported: '*', reexport: 1 })
    else if (n.type === 'dotted_name' || n.type === 'aliased_import') { const it = item(n, mod); out.push({ ...it, imported: it.imported.split('.').at(-1) }) }
  }
  return out
}

function goImports(node) {
  const specs = []
  const walk = (n) => { if (n.type === 'import_spec') specs.push(n); else for (const c of n.namedChildren) walk(c) }
  walk(node)
  return specs.map((s) => {
    const spec = str(s.childForFieldName('path'))
    const name = s.childForFieldName('name')?.text
    return { spec, local: name ?? spec.split('/').at(-1).replace(/^go-|\.v\d+$/g, ''), imported: '*' }
  })
}

function javaImports(node) {
  const t = node.text.replace(/^import\s+(static\s+)?/, '').replace(/;\s*$/, '').trim()
  if (t.endsWith('.*')) return [{ spec: t.slice(0, -2), local: '*', imported: '*', reexport: 1 }]
  return [{ spec: t, local: t.split('.').at(-1), imported: t.split('.').at(-1) }]
}

function csImports(node) {
  const n = node.namedChildren.find((c) => c.type === 'qualified_name' || c.type === 'identifier')
  return n ? [{ spec: n.text, local: '*', imported: '*', reexport: 1 }] : []
}

function rustImports(node) {
  // use crate::a::b::{C, d::E as F};  -> one line per name
  const out = []
  const walk = (n, prefix) => {
    if (n.type === 'use_as_clause') { const p = n.childForFieldName('path').text; out.push({ spec: prefix + p, local: n.childForFieldName('alias').text, imported: p.split('::').at(-1) }) }
    else if (n.type === 'scoped_use_list') { const p = n.childForFieldName('path')?.text ?? ''; walk(n.childForFieldName('list'), prefix + p + '::') }
    else if (n.type === 'use_list') for (const c of n.namedChildren) walk(c, prefix)
    else if (n.type === 'use_wildcard') out.push({ spec: prefix + n.text.replace(/::\*$/, ''), local: '*', imported: '*', reexport: 1 })
    else if (n.type === 'scoped_identifier' || n.type === 'identifier' || n.type === 'crate' || n.type === 'self' || n.type === 'super') { const p = prefix + n.text; out.push({ spec: p, local: p.split('::').at(-1), imported: p.split('::').at(-1) }) }
  }
  const arg = node.childForFieldName('argument')
  if (arg) walk(arg, '')
  return out
}

function phpImports(node) {
  const out = []
  const walk = (n) => {
    if (n.type === 'namespace_use_clause') { const q = n.namedChildren.find((c) => c.type === 'qualified_name' || c.type === 'name'); const alias = n.childForFieldName('alias') ?? n.namedChildren.find((c, i) => i > 0 && c.type === 'name'); if (q) out.push({ spec: q.text.replace(/^\\/, ''), local: alias?.text ?? q.text.split('\\').at(-1), imported: q.text.split('\\').at(-1) }) }
    else for (const c of n.namedChildren) walk(c)
  }
  walk(node)
  return out
}

function rubyImports(node) {
  const arg = node.childForFieldName('arguments')?.namedChildren[0]
  const spec = arg?.text.replace(/^['"]|['"]$/g, '')
  const fn = node.childForFieldName('method')?.text
  return spec ? [{ spec: (fn === 'require_relative' ? './' : '') + spec, local: '*', imported: '*', reexport: 1 }] : []
}

function cImports(node) {
  const p = node.childForFieldName('path')
  if (!p) return []
  const spec = p.text.replace(/^["<]|[">]$/g, '')
  return [{ spec: p.type === 'system_lib_string' ? spec : './' + spec, local: '*', imported: '*', reexport: 1 }]
}

// ---- language table -----------------------------------------------------------------------------------------

export const LANGUAGES = {
  typescript: { wasm: 'typescript', exts: ['.ts', '.mts', '.cts'], queries: JS_COMMON + TS_ONLY, imports: jsImports, family: 'js' },
  tsx: { wasm: 'tsx', exts: ['.tsx'], queries: JS_COMMON + TS_ONLY + JSX, imports: jsImports, family: 'js' },
  javascript: { wasm: 'javascript', exts: ['.js', '.mjs', '.cjs', '.jsx'], queries: JS_COMMON + JSX, imports: jsImports, family: 'js' },
  python: {
    wasm: 'python', exts: ['.py', '.pyi'], imports: pyImports, family: 'python', self: ['self', 'cls'],
    exported: (name) => !name.startsWith('_'),
    queries: `
(function_definition name: (identifier) @name) @def.function
(class_definition name: (identifier) @name) @def.class
(module (expression_statement (assignment left: (identifier) @name)) @def.const)
(import_statement) @import
(import_from_statement) @import
(call function: (identifier) @callee) @call
(call function: (attribute object: (_) @receiver attribute: (identifier) @callee)) @call
(type (identifier) @type)
(class_definition superclasses: (argument_list (identifier) @extends))
(class_definition superclasses: (argument_list (attribute) @extends))
(decorator (identifier) @ref)
(argument_list (identifier) @ref)
(typed_parameter (identifier) @bind.name type: (type (identifier) @bind.type))
(typed_default_parameter name: (identifier) @bind.name type: (type (identifier) @bind.type))
(assignment left: (identifier) @bindcall.name right: (call function: (_) @bindcall.callee))
(assignment left: (identifier) @bind.name type: (type (identifier) @bind.type))
(assignment left: (identifier) @bindexpr.name right: [(attribute) (identifier)] @bindexpr.value)
(assignment left: (attribute object: (identifier) @_s (#eq? @_s "self") attribute: (identifier) @field.name) right: (call function: (identifier) @field.type))
(assignment left: (attribute object: (identifier) @_s2 (#eq? @_s2 "self") attribute: (identifier) @field.name) type: (type (identifier) @field.type))
`
  },
  go: {
    wasm: 'go', exts: ['.go'], imports: goImports, family: 'go', samePackageDir: true,
    exported: (name) => /^[A-Z]/.test(name),
    queries: `
(function_declaration name: (identifier) @name) @def.function
(method_declaration receiver: (parameter_list (parameter_declaration type: [(type_identifier) @owner (pointer_type (type_identifier) @owner) (generic_type type: (type_identifier) @owner) (pointer_type (generic_type type: (type_identifier) @owner))])) name: (field_identifier) @name) @def.method
(type_declaration (type_spec name: (type_identifier) @name type: (struct_type))) @def.struct
(type_declaration (type_spec name: (type_identifier) @name type: (interface_type))) @def.interface
(type_declaration (type_spec name: (type_identifier) @name)) @def.type
(method_elem name: (field_identifier) @name) @def.method
(source_file (const_declaration (const_spec name: (identifier) @name) @def.const))
(source_file (var_declaration (var_spec name: (identifier) @name) @def.const))
(import_declaration) @import
(call_expression function: (identifier) @callee) @call
(call_expression function: (selector_expression operand: (_) @receiver field: (field_identifier) @callee)) @call
(composite_literal type: (type_identifier) @callee) @new
(composite_literal type: (qualified_type package: (package_identifier) @receiver name: (type_identifier) @callee)) @new
(type_identifier) @type
(argument_list (identifier) @ref)
(method_declaration receiver: (parameter_list (parameter_declaration name: (identifier) @bind.name type: (_) @bind.type)))
(parameter_declaration name: (identifier) @bind.name type: (_) @bind.type)
(var_spec name: (identifier) @bind.name type: (_) @bind.type)
(short_var_declaration left: (expression_list (identifier) @bind.name) right: (expression_list (composite_literal type: (_) @bind.type)))
(short_var_declaration left: (expression_list (identifier) @bind.name) right: (expression_list (unary_expression operand: (composite_literal type: (_) @bind.type))))
(short_var_declaration left: (expression_list (identifier) @bindcall.name) right: (expression_list (call_expression function: (_) @bindcall.callee)))
(short_var_declaration left: (expression_list (identifier) @bindexpr.name) right: (expression_list (selector_expression) @bindexpr.value))
(field_declaration name: (field_identifier) @field.name type: (_) @field.type)
`
  },
  java: {
    wasm: 'java', exts: ['.java'], imports: javaImports, family: 'java', samePackageDir: true,
    queries: `
(class_declaration name: (identifier) @name) @def.class
(interface_declaration name: (identifier) @name) @def.interface
(enum_declaration name: (identifier) @name) @def.enum
(record_declaration name: (identifier) @name) @def.class
(annotation_type_declaration name: (identifier) @name) @def.interface
(method_declaration name: (identifier) @name) @def.method
(constructor_declaration name: (identifier) @name) @def.method
(import_declaration) @import
(method_invocation object: (_) @receiver name: (identifier) @callee) @call
(method_invocation !object name: (identifier) @callee) @call
(object_creation_expression type: (type_identifier) @callee) @new
(object_creation_expression type: (generic_type (type_identifier) @callee)) @new
(type_identifier) @type
(superclass (type_identifier) @extends)
(superclass (generic_type (type_identifier) @extends))
(super_interfaces (type_list (type_identifier) @implements))
(super_interfaces (type_list (generic_type (type_identifier) @implements)))
(extends_interfaces (type_list (type_identifier) @extends))
(method_reference (identifier) @ref)
(field_declaration type: (_) @field.type declarator: (variable_declarator name: (identifier) @field.name))
(local_variable_declaration type: (_) @bind.type declarator: (variable_declarator name: (identifier) @bind.name))
(formal_parameter type: (_) @bind.type name: (identifier) @bind.name)
`
  },
  csharp: {
    wasm: 'c-sharp', exts: ['.cs'], imports: csImports, family: 'csharp',
    queries: `
(class_declaration name: (identifier) @name) @def.class
(interface_declaration name: (identifier) @name) @def.interface
(struct_declaration name: (identifier) @name) @def.struct
(enum_declaration name: (identifier) @name) @def.enum
(record_declaration name: (identifier) @name) @def.class
(method_declaration name: (identifier) @name) @def.method
(constructor_declaration name: (identifier) @name) @def.method
(property_declaration name: (identifier) @name) @def.property
(namespace_declaration name: (_) @name) @def.module
(file_scoped_namespace_declaration name: (_) @name) @def.module
(delegate_declaration name: (identifier) @name) @def.type
(using_directive) @import
(invocation_expression function: (identifier) @callee) @call
(invocation_expression function: (member_access_expression expression: (_) @receiver name: (identifier) @callee)) @call
(invocation_expression function: (generic_name (identifier) @callee)) @call
(invocation_expression function: (member_access_expression expression: (_) @receiver name: (generic_name (identifier) @callee))) @call
(object_creation_expression type: (identifier) @callee) @new
(object_creation_expression type: (generic_name (identifier) @callee)) @new
(base_list (identifier) @extends)
(base_list (generic_name (identifier) @extends))
(parameter type: (identifier) @type)
(variable_declaration type: (identifier) @type)
(property_declaration type: (identifier) @type)
(field_declaration (variable_declaration type: (_) @field.type (variable_declarator (identifier) @field.name)))
(property_declaration type: (_) @field.type name: (identifier) @field.name)
(parameter type: (_) @bind.type name: (identifier) @bind.name)
(local_declaration_statement (variable_declaration type: (_) @bind.type (variable_declarator (identifier) @bind.name)))
`
  },
  rust: {
    wasm: 'rust', exts: ['.rs'], imports: rustImports, family: 'rust', self: ['self', 'Self'],
    queries: `
(function_item name: (identifier) @name) @def.function
(function_signature_item name: (identifier) @name) @def.method
(struct_item name: (type_identifier) @name) @def.struct
(enum_item name: (type_identifier) @name) @def.enum
(trait_item name: (type_identifier) @name) @def.trait
(type_item name: (type_identifier) @name) @def.type
(union_item name: (type_identifier) @name) @def.struct
(mod_item name: (identifier) @name) @def.module
(const_item name: (identifier) @name) @def.const
(static_item name: (identifier) @name) @def.const
(macro_definition name: (identifier) @name) @def.function
(impl_item type: [(type_identifier) @owner (generic_type type: (type_identifier) @owner)]) @container
(impl_item trait: [(type_identifier) @implements (generic_type type: (type_identifier) @implements) (scoped_type_identifier name: (type_identifier) @implements)] type: [(type_identifier) @owner (generic_type type: (type_identifier) @owner)])
(use_declaration) @import
(call_expression function: (identifier) @callee) @call
(call_expression function: (field_expression value: (_) @receiver field: (field_identifier) @callee)) @call
(call_expression function: (scoped_identifier path: (_) @receiver name: (identifier) @callee)) @call
(call_expression function: (generic_function function: (identifier) @callee)) @call
(call_expression function: (generic_function function: (scoped_identifier path: (_) @receiver name: (identifier) @callee))) @call
(macro_invocation macro: (identifier) @callee) @call
(token_tree (identifier) @callee @call . (token_tree))
(struct_expression name: (type_identifier) @callee) @new
(struct_expression name: (scoped_type_identifier path: (_) @receiver name: (type_identifier) @callee)) @new
(type_identifier) @type
(arguments (identifier) @ref)
(parameter pattern: (identifier) @bind.name type: (_) @bind.type)
(let_declaration pattern: (identifier) @bind.name type: (_) @bind.type)
(let_declaration pattern: (identifier) @bind.name value: (struct_expression name: (_) @bind.type))
(let_declaration pattern: (identifier) @bindcall.name value: (call_expression function: (_) @bindcall.callee))
(field_declaration name: (field_identifier) @field.name type: (_) @field.type)
`,
    exported: null // uses visibility (pub) — see extract
  },
  php: {
    wasm: 'php', exts: ['.php'], imports: phpImports, family: 'php',
    queries: `
(class_declaration name: (name) @name) @def.class
(interface_declaration name: (name) @name) @def.interface
(trait_declaration name: (name) @name) @def.trait
(enum_declaration name: (name) @name) @def.enum
(function_definition name: (name) @name) @def.function
(method_declaration name: (name) @name) @def.method
(namespace_use_declaration) @import
(function_call_expression function: (name) @callee) @call
(function_call_expression function: (qualified_name (name) @callee)) @call
(member_call_expression object: (_) @receiver name: (name) @callee) @call
(nullsafe_member_call_expression object: (_) @receiver name: (name) @callee) @call
(scoped_call_expression scope: (_) @receiver name: (name) @callee) @call
(object_creation_expression (name) @callee) @new
(object_creation_expression (qualified_name (name) @callee)) @new
(base_clause (name) @extends)
(base_clause (qualified_name (name) @extends))
(class_interface_clause (name) @implements)
(class_interface_clause (qualified_name (name) @implements))
(named_type (name) @type)
(simple_parameter type: (named_type (name) @bind.type) name: (variable_name (name) @bind.name))
(property_promotion_parameter type: (named_type (name) @field.type) name: (variable_name (name) @field.name))
(property_declaration type: (named_type (name) @field.type) (property_element (variable_name (name) @field.name)))
`
  },
  ruby: {
    wasm: 'ruby', exts: ['.rb'], imports: rubyImports, family: 'ruby', self: ['self'],
    queries: `
(class name: (constant) @name) @def.class
(module name: (constant) @name) @def.module
(method name: (_) @name) @def.method
(singleton_method name: (_) @name) @def.method
(call method: (identifier) @_m (#match? @_m "^require(_relative)?$")) @import
(call receiver: (_) @receiver method: (identifier) @callee) @call
(call !receiver method: (identifier) @callee) @call
(call receiver: (constant) @callee method: (identifier) @_n (#eq? @_n "new")) @new
(superclass (constant) @extends)
(superclass (scope_resolution) @extends)
`
  },
  cpp: {
    wasm: 'cpp', exts: ['.c', '.h', '.cc', '.cpp', '.cxx', '.hpp', '.hh', '.hxx'], imports: cImports, family: 'c',
    queries: `
(function_definition declarator: (function_declarator declarator: (identifier) @name)) @def.function
(function_definition declarator: (function_declarator declarator: (field_identifier) @name)) @def.method
(function_definition declarator: (function_declarator declarator: (qualified_identifier scope: (namespace_identifier) @owner name: (identifier) @name))) @def.method
(function_definition declarator: (pointer_declarator declarator: (function_declarator declarator: (identifier) @name))) @def.function
(class_specifier name: (type_identifier) @name body: (_)) @def.class
(struct_specifier name: (type_identifier) @name body: (_)) @def.struct
(enum_specifier name: (type_identifier) @name body: (_)) @def.enum
(namespace_definition name: (namespace_identifier) @name) @def.module
(field_declaration declarator: (function_declarator declarator: (field_identifier) @name)) @def.method
(type_definition declarator: (type_identifier) @name) @def.type
(preproc_include) @import
(call_expression function: (identifier) @callee) @call
(call_expression function: (field_expression argument: (_) @receiver field: (field_identifier) @callee)) @call
(call_expression function: (qualified_identifier scope: (_) @receiver name: (identifier) @callee)) @call
(new_expression type: (type_identifier) @callee) @new
(base_class_clause (type_identifier) @extends)
(type_identifier) @type
(declaration type: (type_identifier) @bind.type declarator: (identifier) @bind.name)
(parameter_declaration type: (type_identifier) @bind.type declarator: (identifier) @bind.name)
(parameter_declaration type: (type_identifier) @bind.type declarator: (pointer_declarator declarator: (identifier) @bind.name))
(parameter_declaration type: (type_identifier) @bind.type declarator: (reference_declarator (identifier) @bind.name))
(field_declaration type: (type_identifier) @field.type declarator: (field_identifier) @field.name)
(field_declaration type: (type_identifier) @field.type declarator: (pointer_declarator declarator: (field_identifier) @field.name))
`
  }
}

export const EXT_TO_LANG = {}
for (const [lang, cfg] of Object.entries(LANGUAGES)) for (const e of cfg.exts) EXT_TO_LANG[e] = lang

export function langOf(path) {
  const i = path.lastIndexOf('.')
  if (i < 0) return null
  return EXT_TO_LANG[path.slice(i).toLowerCase()] ?? null
}

export const isTest = (p) => /(^|\/)(__tests__|tests?|spec|e2e)\/|(^|\/)tests?\.py$|(^|\/)test_[^/]*\.py$|\.(test|spec|e2e)\.[cm]?[jt]sx?$|_test\.go$|(^|\/)test_[^/]*\.py$|_test\.py$|Tests?\.(cs|java)$|_spec\.rb$/.test(p)
export const isGenerated = (p) => /(^|\/)(generated|__generated__|gen|vendor|third_party)\/|\.(min|bundle)\.js$|\.d\.ts$|\.pb\.go$|_pb2\.py$|\.g\.cs$|\.designer\.cs$/i.test(p)
