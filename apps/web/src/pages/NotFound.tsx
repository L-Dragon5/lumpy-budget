import { Link, useLocation } from "react-router";
import { Button } from "@/components/ui/button";
import { Empty, EmptyContent, EmptyDescription, EmptyHeader, EmptyTitle } from "@/components/ui/empty";

export default function NotFound() {
  const { pathname } = useLocation();

  return (
    <Empty>
      <EmptyHeader>
        <EmptyTitle>No page at {pathname}</EmptyTitle>
        <EmptyDescription>
          That link is wrong or the page moved. Pick a section above, or go back to the dashboard.
        </EmptyDescription>
      </EmptyHeader>
      <EmptyContent>
        <Button render={<Link to="/" />} nativeButton={false}>
          Back to dashboard
        </Button>
      </EmptyContent>
    </Empty>
  );
}
