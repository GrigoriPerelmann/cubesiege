#!/usr/bin/env python3
"""Bundle public/ into one self-contained file: cube-siege.html

The result can be opened by double-click (file://), sent to friends or uploaded to any
static web host. Each ES module is wrapped in its own function scope; imports/exports
are rewritten to a small module table.
"""
import os
import re

ROOT = os.path.dirname(os.path.abspath(__file__))
PUB = os.path.join(ROOT, 'public')
OUT = os.path.join(ROOT, 'cube-siege.html')

IMPORT_RE = re.compile(r"^import\s+(.+?)\s+from\s+'\./([\w-]+)\.js';\s*$", re.M)
EXPORT_DECL_RE = re.compile(r'^export\s+(?:async\s+)?(class|function|const|let)\s+(\w+)', re.M)
EXPORT_LIST_RE = re.compile(r'^export\s*\{([^}]*)\};?\s*$', re.M)


def load_module(name, seen, order):
    if name in seen:
        return
    seen.add(name)
    src = open(os.path.join(PUB, 'js', name + '.js'), encoding='utf-8').read()
    for _, dep in IMPORT_RE.findall(src):
        load_module(dep, seen, order)
    order.append((name, src))


def transform(name, src):
    exports = [m.group(2) for m in EXPORT_DECL_RE.finditer(src)]
    for m in EXPORT_LIST_RE.finditer(src):
        exports += [x.strip() for x in m.group(1).split(',') if x.strip()]
    src = EXPORT_LIST_RE.sub('', src)
    src = EXPORT_DECL_RE.sub(lambda m: m.group(0)[len('export '):], src)

    def imp(m):
        what, dep = m.group(1), m.group(2)
        if what.startswith('* as '):
            return f'const {what[5:].strip()} = __mods[{dep!r}];'
        return f'const {what} = __mods[{dep!r}];'
    src = IMPORT_RE.sub(imp, src)
    return f"// ---- {name}.js\n__mods[{name!r}] = (() => {{\n{src}\nreturn {{ {', '.join(exports)} }};\n}})();\n"


def main():
    html = open(os.path.join(PUB, 'index.html'), encoding='utf-8').read()
    css = open(os.path.join(PUB, 'style.css'), encoding='utf-8').read()
    order = []
    load_module('main', set(), order)
    js = "'use strict';\nconst __mods = {};\n" + ''.join(transform(n, s) for n, s in order)
    html = html.replace('<link rel="stylesheet" href="style.css">', '<style>\n' + css + '</style>')
    html = html.replace('<script type="module" src="js/main.js"></script>',
                        '<script>\n(() => {\n' + js.replace('</script', '<\\/script') + '})();\n</script>')
    with open(OUT, 'w', encoding='utf-8') as f:
        f.write(html)
    print(f'wrote {os.path.relpath(OUT, ROOT)} ({len(html) // 1024} KB, modules: {", ".join(n for n, _ in order)})')


if __name__ == '__main__':
    main()
