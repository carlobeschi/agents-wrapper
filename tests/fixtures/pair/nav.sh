#!/bin/sh
# Stands in for the navigator: helps when asked, cuts in once on the first edit, signs off.
case "$1" in
  *"has asked you for help"*) echo "Use 42.";;
  *"hidden tests pass"*) printf 'Looks right.\nNext: end\n';;
  *"driver edits"*) if [ -f ../../nav-cut ]; then echo "(silent)"; else touch ../../nav-cut; echo "That says 41; the task wants 42."; fi;;
  *) echo "(silent)";;
esac
