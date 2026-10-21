# Bitácora de Agua

App web instalable para la captura diaria de lecturas de medidores, calidad de agua y prueba de sedimentación.

## Privacidad

- Los registros se guardan **solo en el dispositivo**, cifrados con AES-256-GCM.
- La llave se deriva de la contraseña del usuario (PBKDF2-SHA256, 600 000 iteraciones).
- La app no envía datos a ningún servidor. Este repositorio contiene únicamente el programa, sin datos.
- Los respaldos se exportan cifrados con una contraseña.

## Funciona sin conexión

Después de abrirla una vez, se puede instalar en la pantalla de inicio (Safari → Compartir → Agregar a pantalla de inicio) y funciona sin internet.

## Librerías incluidas

- [SheetJS Community Edition](https://sheetjs.com) — Apache 2.0 (`vendor/LICENSE-xlsx.txt`)
- [jsPDF](https://github.com/parallax/jsPDF) — MIT (`vendor/LICENSE-jspdf.txt`)
- [jsPDF-AutoTable](https://github.com/simonbengtsson/jsPDF-AutoTable) — MIT (`vendor/LICENSE-jspdf-autotable.txt`)
- [Chart.js](https://www.chartjs.org) 4.4.1 — MIT (`vendor/LICENSE-chartjs.txt`)
- Fuente [Plus Jakarta Sans](https://github.com/tokotype/PlusJakartaSans) — SIL Open Font License 1.1 (`vendor/fonts/LICENSE-PlusJakartaSans-OFL.txt`)
