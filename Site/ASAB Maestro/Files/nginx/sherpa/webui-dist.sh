#!/bin/bash -e


TEMPFILE=/tmp/dist.tar.lzma
ASAB_WEBUI_DISTRIBUTION_BASEURL=${ASAB_WEBUI_DISTRIBUTION_BASEURL:-https://asabwebui.z16.web.core.windows.net/}
ASAB_WEBUI_DISTRIBUTION_APP=${ASAB_WEBUI_DISTRIBUTION_APP:-seacat:master seacat-auth:master}
ASAB_WEBUI_DISTRIBUTION_MAXSIZE=${ASAB_WEBUI_DISTRIBUTION_MAXSIZE:-100M}

# This is the cleanup function that is executed at the exit time
function cleanup {
	rm -f ${TEMPFILE} /webroot/*.etag-new
	rm -rf /webroot/*-new
}


function install {
	echo "Web UI Distribution: Installing $1 $2 ..."

	# Download the distribution file
	rm -f ${TEMPFILE}
	curl --silent --show-error \
		-o ${TEMPFILE} \
		--max-filesize ${ASAB_WEBUI_DISTRIBUTION_MAXSIZE} \
		--etag-save /webroot/$1.etag-new \
		--etag-compare /webroot/$1.etag \
		${ASAB_WEBUI_DISTRIBUTION_BASEURL}$1/$2/$1-webui.tar.lzma

	if [ $? -ne 0 ]
	then
		echo "Web UI Distribution: Failed to download the $1."
		exit 1
	fi

	if [ ! -f ${TEMPFILE} ]; then
		# This happens then ETag check indicates no change in of the previously downloaded distribution
		echo "Web UI Distribution: $1 already installed and up-to-date."
		rm /webroot/$1.etag-new
		return
	fi

	# Unpack the distribution in the temporary locatiom
	mkdir -p /webroot/$1-new
	lzcat ${TEMPFILE} | tar x -C /webroot/$1-new
	if [ $? -ne 0 ]
	then
		echo "Web UI Distribution: Failed to untar the $1."
		exit 2
	fi

	# Everything looks alright, so move the new installation in place
	mv /webroot/$1.etag-new /webroot/$1.etag
	rm -rf /webroot/$1-webui
	mv /webroot/$1-new /webroot/$1-webui

}


echo "Web UI Distribution: Started ..."
trap cleanup EXIT

for app in $ASAB_WEBUI_DISTRIBUTION_APP
do
	install ${app/:/ }
done

echo "Web UI Distribution: Completed."
