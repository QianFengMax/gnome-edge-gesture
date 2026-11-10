#!/usr/bin/env python3
"""MouseInc.exe 静态探针：PE 头、节表熵、导入表、资源、关键字符串。

用法: python3 pe_probe.py <exe>
不依赖 pefile（纯 struct 解析），输出为可入库的纯文本证据。
"""
import sys, struct, math, os, re, collections

def ent(b):
    if not b:
        return 0.0
    c = collections.Counter(b)
    n = len(b)
    return -sum((v / n) * math.log2(v / n) for v in c.values())

def main(path):
    d = open(path, 'rb').read()
    pe = struct.unpack_from('<I', d, 0x3c)[0]
    assert d[pe:pe + 4] == b'PE\x00\x00'
    machine, nsec, tstamp = struct.unpack_from('<HHI', d, pe + 4)
    optsz, chars = struct.unpack_from('<HH', d, pe + 20)
    opt = pe + 24
    magic = struct.unpack_from('<H', d, opt)[0]
    pe32p = magic == 0x20b
    print(f'file            {path} ({len(d)} bytes)')
    print(f'machine         0x{machine:04x}  ({ {0x14c:"i386", 0x8664:"x86_64", 0xaa64:"arm64"}.get(machine,"?") })')
    print(f'timestamp       {tstamp}  ({__import__("time").strftime("%Y-%m-%d %H:%M:%SZ", __import__("time").gmtime(tstamp))})')
    print(f'opt magic       0x{magic:04x}  ({ "PE32+" if pe32p else "PE32" })  sections={nsec}')
    dd = opt + (112 if pe32p else 96)
    dirs = {}
    for idx, nm in enumerate(['export', 'import', 'resource', 'exception', 'security', 'reloc', 'debug', 'arch', 'globalptr', 'tls', 'loadcfg', 'boundimport', 'iat', 'delayimport', 'clr', 'reserved']):
        rva, sz = struct.unpack_from('<II', d, dd + idx * 8)
        if rva or sz:
            dirs[nm] = (rva, sz)
            print(f'  data[{idx:2}] {nm:12} rva=0x{rva:x} size=0x{sz:x}')
    sh = opt + optsz
    secs = []
    for i in range(nsec):
        o = sh + i * 40
        name = d[o:o + 8].rstrip(b'\x00').decode('latin1')
        vs, va, rs, rp = struct.unpack_from('<IIII', d, o + 8)
        fl = struct.unpack_from('<I', d, o + 36)[0]
        body = d[rp:rp + rs] if rs else b''
        e = ent(body)
        secs.append((name, va, vs, rp, rs, fl, e))
        print(f'  {name:9} vaddr=0x{va:08x} vsz=0x{vs:08x} raw=0x{rp:08x} rsz=0x{rs:08x} flags=0x{fl:08x} entropy={e:.3f}')
    if any(s[6] > 7.2 for s in secs):
        print('!! 高熵节存在，可能是压缩/加密外壳')
    print('imports:')
    # 原始导入表（朴素解析，够用即可）
    if 'import' in dirs:
        rva = dirs['import'][0]
        off = rva_to_off(secs, rva)
        if off:
            i = off
            while True:
                ilt, ts, fc, name_rva, iat = struct.unpack_from('<IIIII', d, i)
                if name_rva == 0:
                    break
                noff = rva_to_off(secs, name_rva)
                dll = d[noff:d.index(b'\x00', noff)].decode('latin1') if noff else '?'
                funcs = []
                j = rva_to_off(secs, ilt or iat)
                while j and j + 4 <= len(d):
                    f = struct.unpack_from('<I', d, j)[0]
                    if f == 0:
                        break
                    if f & 0x80000000:
                        funcs.append('ord#%d' % (f & 0xffff))
                    else:
                        fo = rva_to_off(secs, f)
                        if fo and d[fo:fo + 2] == b'\x00\x00':
                            funcs.append(d[fo + 2:d.index(b'\x00', fo + 2)].decode('latin1'))
                    j += 4
                print(f'  {dll}: {len(funcs)} 个')
                interesting = [x for x in funcs if re.search(r'(Hook|Inject|SendInput|SetWinEvent|GetAsyncKeyState|Ocr|Ocr|Gdi|BitBlt|Wheel|DeviceIo|Nt|Zw)', x)]
                if interesting:
                    print('     关键:', ', '.join(interesting[:25]))
                i += 20
    print('strings（宽字符 + ASCII 关键字命中）:')
    hits = collections.Counter()
    for m in re.finditer(rb'(?:[\x20-\x7e]\x00){6,}', d):
        s = m.group().decode('utf-16-le', 'ignore')
        hits[s] += 1
    kw = re.compile(r'(Gesture|gesture|Direction|Ocr|OCR|ocr|Ink|Trace|Bright|Volume|Wheel|Squar|Circle|Clockwise|template|Template)')
    shown = 0
    for s, c in hits.most_common(4000):
        if kw.search(s) and 4 < len(s) < 90:
            print(f'  u16[{c}] {s}')
            shown += 1
            if shown > 120:
                break

def rva_to_off(secs, rva):
    for name, va, vs, rp, rs, fl, e in secs:
        if va <= rva < va + max(vs, rs):
            return rp + (rva - va)
    return None

if __name__ == '__main__':
    main(sys.argv[1])
