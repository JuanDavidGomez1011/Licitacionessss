"""Repara el doble codificado queProvoco `Set-Content` en ESTADO-PROYECTO.md.

Windows PowerShell 5.1 leyo el UTF-8 con la codificacion por defecto (cp1252) y
lo escribio de vuelta como UTF-8: cada caracter acentuado quedo como dos
caracteres ASCII. Se revierte haciendo lo contrario: lo que hay ahora en el archivo es
`bytes_utf8.decode('cp1252').encode('cp1252')`, o sea que deshacer es
`texto.encode('cp1252').decode('utf-8')`.
"""

from __future__ import annotations

import pathlib
import sys

RUTA = pathlib.Path(sys.argv[1] if len(sys.argv) > 1 else "ESTADO-PROYECTO.md")

bytes_crudo = RUTA.read_bytes()
if bytes_crudo[:3] == b"\xef\xbb\xbf":
    print("el archivo tiene BOM: se quita antes de decodificar")
    texto = bytes_crudo[3:].decode("utf-8")
else:
    texto = bytes_crudo.decode("utf-8")

# .NET (y por tanto PowerShell) mapea los 5 bytes que cp1252 deja sin definir
# al caracter de control del mismo valor, mientras que el codec de Python lanza
# error al codificarlos. Sin esta tabla, el 0x90 que aparece en un caracter
# acentuado hace fallar el encode entero.
INDEFINIDOS = {0x81: "\x81", 0x8D: "\x8d", 0x8F: "\x8f", 0x90: "\x90", 0x9D: "\x9d"}
TABLA = {ord(c): b for b, c in INDEFINIDOS.items()}

bytes_a_utf8 = bytearray()
for c in texto:
    if ord(c) in TABLA:
        bytes_a_utf8.append(TABLA[ord(c)])
    else:
        bytes_a_utf8 += c.encode("cp1252")

arreglado = bytes(bytes_a_utf8).decode("utf-8")
print(f"caracteres: {len(texto)} -> {len(arreglado)}")
print("reemplazos U+FFFD:", arreglado.count("�"))
print("muestra antes:", repr(texto[2000:2040]))
print("muestra despues:", repr(arreglado[2000:2040]))
RUTA.write_text(arreglado, encoding="utf-8", newline="\n")
print("escrito sin BOM, con saltos de linea \\n")
print("escrito sin BOM, con saltos de linea \\n")