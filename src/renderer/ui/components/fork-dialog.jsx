import { Button } from '@/components/ui/button';
import {
  Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle,
} from '@/components/ui/dialog';

export function ForkDialog({ fork, onAnswer }) {
  return (
    <Dialog open={!!fork} onOpenChange={(next) => { if (!next) onAnswer('cancel'); }}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Continue on {fork?.label} in a new chat</DialogTitle>
          <DialogDescription>
            This chat stays on its own CLI. The new one starts with what you hand it.
          </DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <Button variant="ghost" onClick={() => onAnswer('cancel')}>Cancel</Button>
          <Button variant="outline" onClick={() => onAnswer('summary')}>
            Summary · {fork?.sizes.summary} characters
          </Button>
          <Button autoFocus onClick={() => onAnswer('complete')}>
            Complete · {fork?.sizes.complete} characters
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
