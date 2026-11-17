"""A real left click at x y on the X display in $DISPLAY, through XTest.

The X server delivers it to the window under the pointer, and Chromium hands it
to whichever view is on top at that point, the way it does for a person.
drive.mjs runs this only for instances on their own hidden display.
"""
import ctypes
import sys
import time

x11 = ctypes.cdll.LoadLibrary('libX11.so.6')
xtst = ctypes.cdll.LoadLibrary('libXtst.so.6')
x11.XOpenDisplay.restype = ctypes.c_void_p
display = x11.XOpenDisplay(None)
if not display:
    sys.exit('cannot open the X display in $DISPLAY')
display = ctypes.c_void_p(display)

x, y = int(sys.argv[1]), int(sys.argv[2])
xtst.XTestFakeMotionEvent(display, -1, x, y, 0)
x11.XFlush(display)
time.sleep(0.1)
xtst.XTestFakeButtonEvent(display, 1, True, 0)
x11.XFlush(display)
time.sleep(0.05)
xtst.XTestFakeButtonEvent(display, 1, False, 0)
x11.XFlush(display)
x11.XCloseDisplay(display)
