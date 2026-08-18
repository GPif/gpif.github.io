# frozen_string_literal: true

require 'open3'

Jekyll::Hooks.register :site, :post_write do |site|
  destination = site.dest

  puts "Running post-processing on #{destination}"

  command = [
    'node',
    'scripts/post-process.mjs',
    destination
  ]

  stdout, stderr, status = Open3.capture3(*command)

  puts stdout unless stdout.empty?
  warn stderr unless stderr.empty?

  unless status.success?
    raise Jekyll::Errors::FatalException,
          "Post-processing failed with exit status #{status.exitstatus}"
  end
end
