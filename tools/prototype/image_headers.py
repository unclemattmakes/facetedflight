#!/usr/bin/env python3
"""Dump width/height/bit-depth of PNG/TGA/BMP/JPG/EXR/PSD files without decoding pixels.
Usage: python image_headers.py <file-or-dir> [...]
Reads only the header bytes so multi-hundred-MB World Machine exports are cheap to inspect.
"""
import os, struct, sys

def png_info(b):
    if b[:8] != b'\x89PNG\r\n\x1a\n': return None
    w, h, depth, ctype = struct.unpack('>IIBB', b[16:26])
    ctypes = {0:'gray',2:'rgb',3:'indexed',4:'gray+alpha',6:'rgba'}
    return dict(fmt='png', w=w, h=h, bits_per_channel=depth, channels=ctypes.get(ctype, ctype))

def tga_info(b):
    idlen, cmaptype, imgtype = b[0], b[1], b[2]
    w, h, bpp, desc = struct.unpack('<HHBB', b[12:18])
    types = {2:'truecolor',3:'grayscale',10:'rle-truecolor',11:'rle-grayscale',1:'colormapped',9:'rle-colormapped'}
    return dict(fmt='tga', w=w, h=h, bpp=bpp, type=types.get(imgtype, imgtype), alpha_bits=desc & 0x0f, top_left_origin=bool(desc & 0x20))

def bmp_info(b):
    if b[:2] != b'BM': return None
    fsize, = struct.unpack('<I', b[2:6])
    hdrsize, = struct.unpack('<I', b[14:18])
    w, h, planes, bpp, comp = struct.unpack('<iiHHI', b[18:34])
    return dict(fmt='bmp', w=w, h=abs(h), bpp=bpp, compression=comp, dib_header=hdrsize)

def jpg_info(b):
    if b[:2] != b'\xff\xd8': return None
    i = 2
    while i < len(b) - 9:
        if b[i] != 0xFF: i += 1; continue
        marker = b[i+1]
        if marker in (0xC0, 0xC1, 0xC2):
            prec, h, w, comps = struct.unpack('>BHHB', b[i+4:i+10])
            return dict(fmt='jpg', w=w, h=h, bits_per_channel=prec, channels=comps)
        seglen, = struct.unpack('>H', b[i+2:i+4]); i += 2 + seglen
    return dict(fmt='jpg')

def exr_info(b):
    if b[:4] != b'\x76\x2f\x31\x01': return None
    return dict(fmt='exr', note='OpenEXR (half/float HDR); header not parsed')

def psd_info(b):
    if b[:4] != b'8BPS': return None
    ver, = struct.unpack('>H', b[4:6]); ch, h, w, depth, mode = struct.unpack('>HIIHH', b[12:26])
    return dict(fmt='psd', w=w, h=h, bits_per_channel=depth, channels=ch, mode=mode)

def info(path):
    with open(path, 'rb') as f: b = f.read(65536)
    ext = os.path.splitext(path)[1].lower()
    r = None
    if ext == '.png': r = png_info(b)
    elif ext == '.tga': r = tga_info(b)
    elif ext == '.bmp': r = bmp_info(b)
    elif ext in ('.jpg', '.jpeg'): r = jpg_info(b)
    elif ext == '.exr': r = exr_info(b)
    elif ext == '.psd': r = psd_info(b)
    return r

def main(args):
    files = []
    for a in args:
        if os.path.isdir(a):
            for root, _, names in os.walk(a):
                for n in sorted(names):
                    if os.path.splitext(n)[1].lower() in ('.png','.tga','.bmp','.jpg','.jpeg','.exr','.psd'):
                        files.append(os.path.join(root, n))
        else: files.append(a)
    for p in files:
        try:
            r = info(p); sz = os.path.getsize(p)
            print(f"{sz:>12,d}  {r}  {p}")
        except Exception as e:
            print(f"ERR {p}: {e}")

if __name__ == '__main__': main(sys.argv[1:])
