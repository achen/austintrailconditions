-- 008_add_comment_parent.sql
-- Add parent_post_id to link comments to their parent post
-- Add is_comment flag to distinguish posts from comments

ALTER TABLE trail_reports ADD COLUMN parent_post_id TEXT;
ALTER TABLE trail_reports ADD COLUMN is_comment BOOLEAN NOT NULL DEFAULT false;

CREATE INDEX idx_trail_reports_parent ON trail_reports(parent_post_id) WHERE parent_post_id IS NOT NULL;
